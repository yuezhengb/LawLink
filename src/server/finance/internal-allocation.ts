import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { calculateLawFirmAllocation, financeRoleAssignmentsSchema, financeRuleDefinitionSchema, type FinanceRole } from "@/lib/finance/internal-rules";
import { persistFinancePeriodSnapshots } from "@/server/finance/internal-balances";
import type { PrismaClient } from "@prisma/client";

const periodSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  matterId: z.string().trim().min(1).optional()
}).superRefine((value, context) => {
  if (value.periodEnd <= value.periodStart) context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "期间结束必须晚于开始" });
});

export type AllocationPeriodInput = z.infer<typeof periodSchema>;

export type AllocationPreviewLine = {
  paymentId: string;
  matterId: string;
  targetUserId: string | null;
  sourceKind: "PAYMENT" | "REFUND";
  refundLinkId: string | null;
  sourceOccurredAt: string;
  ruleVersionId: string;
  grossAmount: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
  recipients: AllocationRecipientPreview[];
};

export type AllocationRecipientPreview = {
  paymentId: string;
  matterId: string;
  userId: string;
  role: FinanceRole;
  shareRate: string;
  amount: string;
};

export type AllocationPreview = {
  runId: string;
  periodStart: string;
  periodEnd: string;
  sourceHash: string;
  status: "PREVIEW" | "COMMITTED";
  allocationVersion: 2;
  blockingIssues: string[];
  lines: AllocationPreviewLine[];
  recipients: AllocationRecipientPreview[];
};

export type FinanceAllocationActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceAllocationDependencies = {
  db?: PrismaClient;
  actor?: FinanceAllocationActor;
};

function actorOrSession(actor?: FinanceAllocationActor): Promise<FinanceAllocationActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.rules").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function assertAllocationAccess(actor: FinanceAllocationActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM") {
    const grantsUser = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
    if (scopeFor(grantsUser, "finance.read") === "ALL" && scopeFor(grantsUser, "finance.rules") === "ALL") return;
  }
  throw new ActionError("无权进行内部财务分配");
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

function amount(value: unknown): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value ?? "0"));
}

function textAmount(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

type AllocationDataClient = PrismaClient | Prisma.TransactionClient;

function periodFor(input: AllocationPeriodInput): string {
  return input.periodStart.slice(0, 7);
}

function priorPeriodStart(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  const prior = new Date(Date.UTC(year, month - 2, 1));
  return dayStart(`${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, "0")}-01`);
}

function moneyForHash(value: unknown): string {
  return amount(value).toFixed(2);
}

function distributeRoleAmount(
  paymentId: string,
  matterId: string,
  role: FinanceRole,
  amount: Prisma.Decimal,
  assignments: Array<{ role: FinanceRole; userId: string; shareRate: string }>
): AllocationRecipientPreview[] {
  const ordered = assignments.filter((assignment) => assignment.role === role).sort((a, b) => a.userId.localeCompare(b.userId));
  if (amount.lte(0) || ordered.length === 0) return [];
  let remaining = amount;
  return ordered.map((assignment, index) => {
    const assigned = index === ordered.length - 1
      ? remaining
      : Prisma.Decimal.min(roundMoney(amount.mul(assignment.shareRate)), remaining);
    remaining = remaining.minus(assigned);
    return { paymentId, matterId, userId: assignment.userId, role, shareRate: assignment.shareRate, amount: textAmount(assigned) };
  }).filter((recipient) => new Prisma.Decimal(recipient.amount).gt(0));
}

function proportionalComponents(
  refundAmount: Prisma.Decimal,
  components: Array<{ role: "CHANNEL" | "FIRM" | FinanceRole; amount: Prisma.Decimal }>
): Prisma.Decimal[] {
  const total = components.reduce((sum, component) => sum.plus(component.amount), new Prisma.Decimal(0));
  if (total.lte(0) || refundAmount.lte(0) || refundAmount.gt(total)) throw new Error("退款金额超出原分配金额");
  const totalCents = refundAmount.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const provisional = components.map((component, index) => {
    const exactCents = component.amount.mul(totalCents).div(total);
    const baseCents = exactCents.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR);
    return { index, cents: baseCents, remainder: exactCents.minus(baseCents) };
  });
  const allocatedCents = provisional.reduce((sum, item) => sum.plus(item.cents), new Prisma.Decimal(0));
  let remainingCents = totalCents.minus(allocatedCents).toNumber();
  for (const item of [...provisional].sort((left, right) => right.remainder.comparedTo(left.remainder) || left.index - right.index)) {
    if (remainingCents <= 0) break;
    item.cents = item.cents.plus(1);
    remainingCents -= 1;
  }
  return provisional.sort((left, right) => left.index - right.index).map((item) => item.cents.div(100));
}

function commissionSnapshotIssues(
  payment: { id: string; amount: unknown; sourceEntry: { commissionChildren: Array<{ beneficiaryUserId: string | null; amount: unknown; commissionRateSnapshot: unknown; commissionBaseSnapshot: unknown }> } },
  lawyerPool: Prisma.Decimal,
  recipients: AllocationRecipientPreview[]
): string[] {
  const issues: string[] = [];
  const children = payment.sourceEntry.commissionChildren;
  const recordedByUser = new Map<string, Prisma.Decimal>();
  if (lawyerPool.gt(0) && children.length === 0) return [`付款 ${payment.id} 缺少已确认的律师提成快照`];
  for (const child of children) {
    if (!child.beneficiaryUserId || child.commissionRateSnapshot === null || child.commissionBaseSnapshot === null) {
      issues.push(`付款 ${payment.id} 的提成快照缺少人员、比例或基数`);
      continue;
    }
    if (!new Prisma.Decimal(String(child.commissionBaseSnapshot)).eq(String(payment.amount))) {
      issues.push(`付款 ${payment.id} 的提成快照基数与原收款不一致`);
    }
    recordedByUser.set(child.beneficiaryUserId, (recordedByUser.get(child.beneficiaryUserId) ?? new Prisma.Decimal(0)).plus(String(child.amount)));
  }
  const recipientByUser = new Map<string, Prisma.Decimal>();
  for (const recipient of recipients) {
    recipientByUser.set(recipient.userId, (recipientByUser.get(recipient.userId) ?? new Prisma.Decimal(0)).plus(recipient.amount));
  }
  const totalRecorded = [...recordedByUser.values()].reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0));
  if (!totalRecorded.eq(lawyerPool)) issues.push(`付款 ${payment.id} 的律师池与已确认提成子账总额不一致`);
  const userIds = new Set([...recordedByUser.keys(), ...recipientByUser.keys()]);
  for (const userId of userIds) {
    if (!(recordedByUser.get(userId) ?? new Prisma.Decimal(0)).eq(recipientByUser.get(userId) ?? new Prisma.Decimal(0))) {
      issues.push(`付款 ${payment.id} 人员 ${userId} 的新版分配与已确认提成快照不一致`);
    }
  }
  return issues;
}

async function collectAllocationFacts(input: AllocationPeriodInput, actor: FinanceAllocationActor, db: AllocationDataClient) {
  const period = periodFor(input);
  const periodStart = dayStart(`${period}-01`);
  const [payrollFacts, ledgerFacts, taxFacts, openingFacts, priorRun, operatingCosts, capitalFlows, adjustments, refundLinks] = await Promise.all([
    db.financePayrollFact.findMany({ where: { period }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financePersonLedgerEntry.findMany({
      where: { period, kind: { in: ["SELF_FUNDING_IN", "INCOME_WITHDRAWAL"] } },
      orderBy: [{ targetUserId: "asc" }, { id: "asc" }]
    }),
    db.financePartnerTaxRecord.findMany({ where: { period }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financeOpeningBalance.findMany({ where: { firstPeriod: { lte: period } }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financeCalculationRun.findFirst({
      where: { periodStart: priorPeriodStart(period), periodEnd: periodStart, status: "COMMITTED", supersededById: null },
      orderBy: { calculatedAt: "desc" },
      include: { personPeriodSnapshots: true }
    }),
    db.financeOperatingCost.findMany({ where: { period }, orderBy: [{ category: "asc" }, { id: "asc" }] }),
    db.financeCapitalFlow.findMany({ where: { period }, orderBy: [{ investorId: "asc" }, { id: "asc" }] }),
    db.financeAdjustment.findMany({ where: { period }, orderBy: [{ targetUserId: "asc" }, { id: "asc" }] }),
    db.financeRefundLink.findMany({
      where: {
        active: true,
        sourceRow: { occurredAt: { gte: dayStart(input.periodStart), lt: dayStart(input.periodEnd) } },
        payment: {
          ...(input.matterId ? { matterId: input.matterId } : {}),
          matter: { deletedAt: null, ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined) }
        }
      },
      include: {
        sourceRow: { select: { id: true, occurredAt: true, amount: true, direction: true } },
        payment: { select: { id: true, matterId: true, amount: true, refundedAmount: true, occurredAt: true, moneyKind: true, sourceEntry: { select: { matterId: true, amount: true, moneyKind: true, confirmState: true } } } }
      },
      orderBy: [{ sourceRow: { occurredAt: "asc" } }, { id: "asc" }]
    })
  ]);
  const payments = await db.payment.findMany({
    where: {
      moneyKind: "LAWYER_FEE",
      sourceEntry: { confirmState: "CONFIRMED" },
      occurredAt: { gte: dayStart(input.periodStart), lt: dayStart(input.periodEnd) },
      ...(input.matterId ? { matterId: input.matterId } : {}),
      matter: {
        deletedAt: null,
        ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
      }
    },
    include: {
      sourceEntry: {
        select: {
          commissionChildren: {
            where: { type: "COMMISSION", confirmState: "CONFIRMED" },
            orderBy: [{ beneficiaryUserId: "asc" }, { id: "asc" }],
            select: { beneficiaryUserId: true, amount: true, commissionRateSnapshot: true, commissionBaseSnapshot: true }
          }
        }
      },
      matter: { include: { financeMatterProfile: true, commissionPlans: true } }
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }]
  });

  const blockingIssues: string[] = [];
  const lines: AllocationPreviewLine[] = [];
  const recipients: AllocationRecipientPreview[] = [];
  const ruleVersionIds: string[] = [];
  const hashParts: unknown[] = [];

  if (payments.length === 0 && refundLinks.length === 0) blockingIssues.push("本期没有已确认律师费收款或已确认退款，不能生成空正式分配批次");
  const assignmentRows = payments.flatMap((payment) => {
    const raw = payment.matter.financeMatterProfile?.roleAssignments;
    return Array.isArray(raw) ? raw.filter((row): row is { role: FinanceRole; userId: string; shareRate: string } =>
      Boolean(row && typeof row === "object" && ["SOURCE", "HANDLING", "CO"].includes(String((row as { role?: unknown }).role)) && typeof (row as { userId?: unknown }).userId === "string")
    ) : [];
  });
  const candidateUserIds = [...new Set(assignmentRows.map((assignment) => assignment.userId))];
  const activeUsers = candidateUserIds.length
    ? await db.user.findMany({ where: { id: { in: candidateUserIds }, active: true }, select: { id: true } })
    : [];
  const activeUserIds = new Set(activeUsers.map((user) => user.id));

  for (const payment of payments) {
    const profile = payment.matter.financeMatterProfile;
    const plans = payment.matter.commissionPlans;
    const gross = amount(payment.amount);
    hashParts.push({
      paymentId: payment.id,
      matterId: payment.matterId,
      amount: textAmount(payment.amount),
      occurredAt: payment.occurredAt.toISOString(),
      commissions: payment.sourceEntry.commissionChildren.map((entry) => ({ beneficiaryUserId: entry.beneficiaryUserId, amount: textAmount(amount(entry.amount)), rate: entry.commissionRateSnapshot ? textAmount(amount(entry.commissionRateSnapshot)) : null, base: entry.commissionBaseSnapshot ? textAmount(amount(entry.commissionBaseSnapshot)) : null })),
      profile: profile ? { origin: profile.origin, participantIds: profile.participantIds, roleAssignments: profile.roleAssignments, activeRuleSetId: profile.activeRuleSetId } : null,
      plans: plans.map((plan) => ({ userId: plan.userId, percent: textAmount(amount(plan.percent)), active: plan.active })).sort((a, b) => a.userId.localeCompare(b.userId))
    });
    if (!profile) {
      blockingIssues.push(`案件 ${payment.matterId} 缺少案件财务画像`);
      continue;
    }
    if (gross.lte(0)) {
      blockingIssues.push(`付款 ${payment.id} 金额无效`);
      continue;
    }
    if (!profile.activeRuleSetId) {
      blockingIssues.push(`案件 ${payment.matterId} 未指定有效规则集`);
      continue;
    }
    const rule = await db.financeRuleVersion.findFirst({
      where: {
        ruleSetId: profile.activeRuleSetId,
        publishedAt: { not: null },
        effectiveFrom: { lte: payment.occurredAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: payment.occurredAt } }]
      },
      orderBy: { version: "desc" }
    });
    if (!rule) {
      blockingIssues.push(`案件 ${payment.matterId} 在收款日缺少已发布规则`);
      continue;
    }
    const definition = financeRuleDefinitionSchema.safeParse(rule.definition);
    if (!definition.success) {
      blockingIssues.push(`规则 ${rule.id} 定义不合法`);
      continue;
    }
    if (definition.data.calculationBase !== "GROSS") {
      blockingIssues.push(`规则 ${rule.id} 仍为旧版分配口径，须重新确认毛额基数`);
      continue;
    }
    const percentages = definition.data.percentages;
    let allocation;
    try {
      allocation = calculateLawFirmAllocation(textAmount(gross), {
        calculationBase: "GROSS",
        channelRate: percentages.channelRate,
        firmRate: percentages.firmRate,
        roleRates: { SOURCE: percentages.sourceRate, HANDLING: percentages.handlingRate, CO: percentages.coRate }
      });
    } catch {
      blockingIssues.push(`规则 ${rule.id} 分配比例不合法`);
      continue;
    }

    const rawAssignments = profile.roleAssignments;
    const parsedAssignments = financeRoleAssignmentsSchema.safeParse(rawAssignments);
    if (!parsedAssignments.success) {
      blockingIssues.push(`案件 ${payment.matterId} 的人员角色比例不合法`);
      continue;
    }
    const assignmentUserIds = [...new Set(parsedAssignments.data.map((assignment) => assignment.userId))];
    if (assignmentUserIds.some((userId) => !activeUserIds.has(userId))) {
      blockingIssues.push(`案件 ${payment.matterId} 配置了不存在或已停用的人员`);
      continue;
    }
    const paymentRecipients: AllocationRecipientPreview[] = [];
    const roleRows = [
      ["SOURCE", allocation.roles.SOURCE] as const,
      ["HANDLING", allocation.roles.HANDLING] as const,
      ["CO", allocation.roles.CO] as const
    ];
    let missingRoleAssignment = false;
    for (const [role, roleAmount] of roleRows) {
      if (roleAmount.gt(0) && !parsedAssignments.data.some((assignment) => assignment.role === role)) {
        blockingIssues.push(`案件 ${payment.matterId} 缺少${role}角色人员分配`);
        missingRoleAssignment = true;
        continue;
      }
      paymentRecipients.push(...distributeRoleAmount(payment.id, payment.matterId, role, roleAmount, parsedAssignments.data));
    }
    if (missingRoleAssignment) continue;
    blockingIssues.push(...commissionSnapshotIssues(payment, allocation.lawyerPool, paymentRecipients));
    ruleVersionIds.push(rule.id);
    const line: AllocationPreviewLine = {
      paymentId: payment.id,
      matterId: payment.matterId,
      targetUserId: null,
      sourceKind: "PAYMENT",
      refundLinkId: null,
      sourceOccurredAt: payment.occurredAt.toISOString(),
      ruleVersionId: rule.id,
      grossAmount: textAmount(gross),
      channelAmount: textAmount(allocation.channel),
      firmAmount: textAmount(allocation.firm),
      sourceAmount: textAmount(allocation.roles.SOURCE),
      handlingAmount: textAmount(allocation.roles.HANDLING),
      coAmount: textAmount(allocation.roles.CO),
      recipients: paymentRecipients
    };
    lines.push(line);
    recipients.push(...paymentRecipients);
  }

  if (refundLinks.length > 0) {
    const sortedRefundLinks = [...refundLinks].sort((left, right) =>
      left.sourceRow.occurredAt.getTime() - right.sourceRow.occurredAt.getTime() || left.id.localeCompare(right.id)
    );
    const refundPaymentIds = [...new Set(sortedRefundLinks.map((link) => link.paymentId))];
    const activeRefundAmounts = await db.financeRefundLink.findMany({
      where: { active: true, paymentId: { in: refundPaymentIds }, sourceRow: { occurredAt: { lt: dayStart(input.periodEnd) } } },
      select: { paymentId: true, amount: true }
    });
    const linkedRefundTotals = new Map<string, Prisma.Decimal>();
    for (const link of activeRefundAmounts) {
      linkedRefundTotals.set(link.paymentId, (linkedRefundTotals.get(link.paymentId) ?? new Prisma.Decimal(0)).plus(amount(link.amount)));
    }

    const paymentById = new Map(sortedRefundLinks.map((link) => [link.payment.id, link.payment]));
    type RefundBasisLine = {
      paymentId: string; matterId: string; ruleVersionId: string; grossAmount: unknown; channelAmount: unknown;
      firmAmount: unknown; sourceAmount: unknown; handlingAmount: unknown; coAmount: unknown;
      recipients: Array<{ userId: string; role: FinanceRole; shareRate: unknown; amount: unknown }>;
    };
    const originalLines = new Map<string, RefundBasisLine>();
    for (const line of lines) {
      if (line.sourceKind === "PAYMENT") originalLines.set(line.paymentId, line);
    }
    const historicalPaymentIds = refundPaymentIds.filter((paymentId) => !originalLines.has(paymentId));
    if (historicalPaymentIds.length > 0) {
      const historicalLines = await db.financeAllocationLine.findMany({
        where: {
          paymentId: { in: historicalPaymentIds },
          sourceKind: "PAYMENT",
          run: { is: { status: "COMMITTED", supersededById: null } }
        },
        select: {
          paymentId: true, matterId: true, targetUserId: true, sourceKind: true, refundLinkId: true, sourceOccurredAt: true,
          ruleVersionId: true, grossAmount: true, channelAmount: true, firmAmount: true, sourceAmount: true,
          handlingAmount: true, coAmount: true,
          recipients: { select: { userId: true, role: true, shareRate: true, amount: true } },
          run: { select: { calculatedAt: true } }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      historicalLines.sort((left, right) => right.run.calculatedAt.getTime() - left.run.calculatedAt.getTime());
      for (const line of historicalLines) {
        if (!originalLines.has(line.paymentId)) originalLines.set(line.paymentId, line);
      }
    }

    for (const link of sortedRefundLinks) {
      const payment = paymentById.get(link.paymentId)!;
      const linkedAmount = amount(link.amount);
      const sourceAmount = amount(link.sourceRow.amount);
      const source = payment.sourceEntry;
      if (link.sourceRow.direction !== "DEBIT" || !sourceAmount.lt(0) || !linkedAmount.gt(0) || linkedAmount.gt(sourceAmount.abs())) {
        blockingIssues.push(`退款关联 ${link.id} 与本期银行借方来源不一致`);
        continue;
      }
      if (payment.moneyKind !== "LAWYER_FEE" || !source || source.confirmState !== "CONFIRMED" || source.moneyKind !== "LAWYER_FEE" || source.matterId !== payment.matterId || !amount(source.amount).eq(amount(payment.amount))) {
        blockingIssues.push(`退款关联 ${link.id} 的原律师费收款来源不一致`);
        continue;
      }
      const totalLinkedRefund = linkedRefundTotals.get(link.paymentId) ?? new Prisma.Decimal(0);
      if (totalLinkedRefund.gt(amount(payment.refundedAmount)) || totalLinkedRefund.gt(amount(payment.amount))) {
        blockingIssues.push(`付款 ${payment.id} 的退款关联金额超过已登记退款或原收款金额`);
        continue;
      }

      const original = originalLines.get(payment.id);
      if (!original) {
        blockingIssues.push(`退款关联 ${link.id} 缺少原正式分配快照，不能估算冲回比例`);
        continue;
      }
      const originalGross = amount(original.grossAmount);
      const originalComponents = [
        amount(original.channelAmount), amount(original.firmAmount), amount(original.sourceAmount),
        amount(original.handlingAmount), amount(original.coAmount)
      ];
      const componentTotal = originalComponents.reduce((sum, component) => sum.plus(component), new Prisma.Decimal(0));
      if (!originalGross.gt(0) || !originalGross.eq(amount(payment.amount)) || !componentTotal.eq(originalGross) || linkedAmount.gt(originalGross)) {
        blockingIssues.push(`付款 ${payment.id} 的原正式分配快照金额不守恒，不能冲回`);
        continue;
      }

      const roleAmounts = new Map<FinanceRole, Prisma.Decimal>([
        ["SOURCE", originalComponents[2]], ["HANDLING", originalComponents[3]], ["CO", originalComponents[4]]
      ]);
      const refundComponents = proportionalComponents(linkedAmount, [
        { role: "CHANNEL", amount: originalComponents[0] }, { role: "FIRM", amount: originalComponents[1] },
        { role: "SOURCE", amount: originalComponents[2] }, { role: "HANDLING", amount: originalComponents[3] },
        { role: "CO", amount: originalComponents[4] }
      ]);
      const originalRecipients = original.recipients ?? [];
      let invalidRecipientFacts = false;
      const refundRecipients: AllocationRecipientPreview[] = [];
      for (const role of ["SOURCE", "HANDLING", "CO"] as const) {
        const roleRecipients = originalRecipients.filter((recipient) => recipient.role === role);
        const roleTotal = roleRecipients.reduce((sum, recipient) => sum.plus(amount(recipient.amount)), new Prisma.Decimal(0));
        const roleAmount = roleAmounts.get(role)!;
        if (!roleTotal.eq(roleAmount)) {
          invalidRecipientFacts = true;
          break;
        }
        const refundRoleAmount = refundComponents[role === "SOURCE" ? 2 : role === "HANDLING" ? 3 : 4];
        const distributed = distributeRoleAmount(payment.id, payment.matterId, role, refundRoleAmount, roleRecipients.map((recipient) => ({
          role, userId: recipient.userId, shareRate: String(recipient.shareRate)
        })));
        refundRecipients.push(...distributed.map((recipient) => ({ ...recipient, amount: new Prisma.Decimal(recipient.amount).negated().toFixed(2) })));
      }
      if (invalidRecipientFacts) {
        blockingIssues.push(`付款 ${payment.id} 原人员角色分配明细与正式分配金额不一致，不能冲回`);
        continue;
      }

      const [refundChannel, refundFirm, refundSource, refundHandling, refundCo] = refundComponents;
      const refundLine: AllocationPreviewLine = {
        paymentId: payment.id,
        matterId: payment.matterId,
        targetUserId: null,
        sourceKind: "REFUND",
        refundLinkId: link.id,
        sourceOccurredAt: link.sourceRow.occurredAt.toISOString(),
        ruleVersionId: original.ruleVersionId,
        grossAmount: linkedAmount.negated().toFixed(2),
        channelAmount: refundChannel.negated().toFixed(2),
        firmAmount: refundFirm.negated().toFixed(2),
        sourceAmount: refundSource.negated().toFixed(2),
        handlingAmount: refundHandling.negated().toFixed(2),
        coAmount: refundCo.negated().toFixed(2),
        recipients: refundRecipients
      };
      lines.push(refundLine);
      recipients.push(...refundRecipients);
      hashParts.push({
        kind: "REFUND", refundLinkId: link.id, paymentId: payment.id, matterId: payment.matterId,
        sourceRowId: link.sourceRow.id, occurredAt: link.sourceRow.occurredAt.toISOString(),
        sourceAmount: sourceAmount.toFixed(2), amount: linkedAmount.toFixed(2), refundedAmount: amount(payment.refundedAmount).toFixed(2),
        original: {
          ruleVersionId: original.ruleVersionId,
          grossAmount: originalGross.toFixed(2),
          channelAmount: originalComponents[0].toFixed(2), firmAmount: originalComponents[1].toFixed(2),
          sourceAmount: originalComponents[2].toFixed(2), handlingAmount: originalComponents[3].toFixed(2), coAmount: originalComponents[4].toFixed(2),
          recipients: originalRecipients.map((recipient) => ({ userId: recipient.userId, role: recipient.role, shareRate: String(recipient.shareRate), amount: amount(recipient.amount).toFixed(2) }))
        }
      });
    }
  }

  const personIds = new Set<string>([
    ...recipients.map((recipient) => recipient.userId),
    ...payrollFacts.map((fact) => fact.userId),
    ...ledgerFacts.map((entry) => entry.targetUserId),
    ...taxFacts.map((record) => record.userId),
    ...openingFacts.map((balance) => balance.userId),
    ...(priorRun?.personPeriodSnapshots ?? []).map((snapshot) => snapshot.userId)
  ]);
  const payrollByUser = new Map(payrollFacts.map((fact) => [fact.userId, fact]));
  const openingsByUser = new Map(openingFacts.map((balance) => [balance.userId, balance]));
  const priorPeople = new Set((priorRun?.personPeriodSnapshots ?? []).map((snapshot) => snapshot.userId));
  for (const userId of personIds) {
    const payroll = payrollByUser.get(userId);
    if (!payroll || !payroll.treatmentReviewed) blockingIssues.push(`人员 ${userId} 工资承担口径缺失或尚未复核`);
    if (!priorPeople.has(userId) && openingsByUser.get(userId)?.firstPeriod !== period) {
      blockingIssues.push(`人员 ${userId} 缺少${period}期初余额确认或上期正式余额快照`);
    }
  }

  const snapshotFactsForHash = {
    period,
    payrollFacts: payrollFacts.map((fact) => ({ ...fact, grossSalary: moneyForHash(fact.grossSalary), actualCashPaid: moneyForHash(fact.actualCashPaid), selfCostDue: moneyForHash(fact.selfCostDue), firmSalaryCost: moneyForHash(fact.firmSalaryCost), firmSocialCost: moneyForHash(fact.firmSocialCost), firmFundCost: moneyForHash(fact.firmFundCost) })),
    ledgerFacts: ledgerFacts.map((fact) => ({ id: fact.id, targetUserId: fact.targetUserId, kind: fact.kind, amount: moneyForHash(fact.amount), sourceRef: fact.sourceRef })),
    taxFacts: taxFacts.map((fact) => ({ id: fact.id, userId: fact.userId, firmAdvance: moneyForHash(fact.firmAdvance), personallyPaid: moneyForHash(fact.personallyPaid), phase: fact.phase })),
    openingFacts: openingFacts.map((fact) => ({ id: fact.id, userId: fact.userId, firstPeriod: fact.firstPeriod, distributable: moneyForHash(fact.distributable), reserve: moneyForHash(fact.reserve), evidenceRef: fact.evidenceRef })),
    priorRun: priorRun ? { id: priorRun.id, sourceHash: priorRun.sourceHash, snapshots: priorRun.personPeriodSnapshots.map((snapshot) => ({ userId: snapshot.userId, distributableEnd: moneyForHash(snapshot.distributableEnd), reserveEnd: moneyForHash(snapshot.reserveEnd) })) } : null,
    operatingCosts: operatingCosts.map((cost) => ({ id: cost.id, category: cost.category, amount: moneyForHash(cost.amount), sourceRowId: cost.sourceRowId, evidenceRef: cost.evidenceRef })),
    capitalFlows: capitalFlows.map((flow) => ({ id: flow.id, investorId: flow.investorId, kind: flow.kind, amount: moneyForHash(flow.amount) })),
    adjustments: adjustments.map((adjustment) => ({ id: adjustment.id, targetUserId: adjustment.targetUserId, account: adjustment.account, amount: moneyForHash(adjustment.amount), status: adjustment.status, reversalOfId: adjustment.reversalOfId }))
  };

  const sourceHash = createHash("sha256").update(JSON.stringify({
    engineVersion: "personal-v1",
    input,
    hashParts,
    snapshotFacts: snapshotFactsForHash,
    activeUserIds: [...activeUserIds].sort(),
    ruleVersionIds: [...new Set(ruleVersionIds)].sort(),
    blockingIssues: [...new Set(blockingIssues)]
  }), "utf8").digest("hex");
  return { sourceHash, ruleVersionIds: [...new Set(ruleVersionIds)], blockingIssues: [...new Set(blockingIssues)], lines, recipients };
}

export async function currentAllocationSourceHash(
  input: AllocationPeriodInput,
  dependencies: Omit<FinanceAllocationDependencies, "actor"> = {}
): Promise<string> {
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("分配期间不正确");
  const db = dependencies.db ?? prisma;
  const facts = await collectAllocationFacts(parsed.data, { id: "finance-source-fingerprint", role: "FINANCE" }, db);
  return facts.sourceHash;
}

type PersistedAllocationRecipient = {
  userId: string;
  role: FinanceRole;
  shareRate: unknown;
  amount: unknown;
};

type PersistedAllocationLine = {
  paymentId: string;
  matterId: string;
  targetUserId: string | null;
  sourceKind: "PAYMENT" | "REFUND";
  refundLinkId: string | null;
  sourceOccurredAt: Date | null;
  ruleVersionId: string;
  grossAmount: unknown;
  channelAmount: unknown;
  firmAmount: unknown;
  sourceAmount: unknown;
  handlingAmount: unknown;
  coAmount: unknown;
  recipients: PersistedAllocationRecipient[];
  payment?: { occurredAt: Date };
};

type PersistedAllocationRun = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  sourceHash: string;
  status: "PREVIEW" | "COMMITTED" | "FAILED" | "SUPERSEDED";
  summary: Prisma.JsonValue;
  allocationLines: PersistedAllocationLine[];
};

function readRunSummary(summary: Prisma.JsonValue): {
  allocationVersion: number | null;
  blockingIssues: string[];
  lineCount: number | null;
  recipientCount: number | null;
} {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { allocationVersion: null, blockingIssues: [], lineCount: null, recipientCount: null };
  }
  const value = summary as Record<string, Prisma.JsonValue>;
  return {
    allocationVersion: typeof value.allocationVersion === "number" ? value.allocationVersion : null,
    blockingIssues: Array.isArray(value.blockingIssues) ? value.blockingIssues.filter((item): item is string => typeof item === "string") : [],
    lineCount: typeof value.lineCount === "number" ? value.lineCount : null,
    recipientCount: typeof value.recipientCount === "number" ? value.recipientCount : null
  };
}

function previewFromRun(run: PersistedAllocationRun, fallbackPeriod: AllocationPeriodInput): AllocationPreview {
  const summary = readRunSummary(run.summary);
  if (summary.allocationVersion !== 2) throw new ActionError("该批次不是新版分配预览，请重新生成");
  const lines: AllocationPreviewLine[] = run.allocationLines.map((line) => ({
    paymentId: line.paymentId,
    matterId: line.matterId,
    targetUserId: line.targetUserId,
    sourceKind: line.sourceKind,
    refundLinkId: line.refundLinkId,
    sourceOccurredAt: (line.sourceOccurredAt ?? line.payment?.occurredAt ?? run.periodStart).toISOString(),
    ruleVersionId: line.ruleVersionId,
    grossAmount: textAmount(amount(line.grossAmount)),
    channelAmount: textAmount(amount(line.channelAmount)),
    firmAmount: textAmount(amount(line.firmAmount)),
    sourceAmount: textAmount(amount(line.sourceAmount)),
    handlingAmount: textAmount(amount(line.handlingAmount)),
    coAmount: textAmount(amount(line.coAmount)),
    recipients: line.recipients.map((recipient) => ({
      paymentId: line.paymentId,
      matterId: line.matterId,
      userId: recipient.userId,
      role: recipient.role,
      shareRate: new Prisma.Decimal(String(recipient.shareRate)).toString(),
      amount: textAmount(amount(recipient.amount))
    }))
  }));
  return {
    runId: run.id,
    periodStart: shDayKey(run.periodStart) || fallbackPeriod.periodStart,
    periodEnd: shDayKey(run.periodEnd) || fallbackPeriod.periodEnd,
    sourceHash: run.sourceHash,
    status: run.status === "COMMITTED" ? "COMMITTED" : "PREVIEW",
    allocationVersion: 2,
    blockingIssues: summary.blockingIssues,
    lines,
    recipients: lines.flatMap((line) => line.recipients)
  };
}

function allocationFingerprint(lines: Array<{
  paymentId: string;
  matterId: string;
  targetUserId?: string | null;
  sourceKind: "PAYMENT" | "REFUND";
  refundLinkId: string | null;
  sourceOccurredAt: Date | string | null;
  ruleVersionId: string;
  grossAmount: unknown;
  channelAmount: unknown;
  firmAmount: unknown;
  sourceAmount: unknown;
  handlingAmount: unknown;
  coAmount: unknown;
  recipients: Array<{ userId: string; role: FinanceRole; shareRate: unknown; amount: unknown }>;
}>): string {
  const money = (value: unknown) => amount(value).toFixed(2);
  return JSON.stringify(lines.map((line) => ({
    paymentId: line.paymentId,
    matterId: line.matterId,
    targetUserId: line.targetUserId ?? null,
    sourceKind: line.sourceKind,
    refundLinkId: line.refundLinkId,
    sourceOccurredAt: line.sourceOccurredAt instanceof Date ? line.sourceOccurredAt.toISOString() : line.sourceOccurredAt,
    ruleVersionId: line.ruleVersionId,
    grossAmount: money(line.grossAmount),
    channelAmount: money(line.channelAmount),
    firmAmount: money(line.firmAmount),
    sourceAmount: money(line.sourceAmount),
    handlingAmount: money(line.handlingAmount),
    coAmount: money(line.coAmount),
    recipients: [...line.recipients].map((recipient) => ({
      userId: recipient.userId,
      role: recipient.role,
      shareRate: new Prisma.Decimal(String(recipient.shareRate)).toFixed(6),
      amount: money(recipient.amount)
    })).sort((a, b) => `${a.role}:${a.userId}`.localeCompare(`${b.role}:${b.userId}`))
  })).sort((a, b) => `${a.paymentId}:${a.sourceKind}:${a.refundLinkId ?? ""}`.localeCompare(`${b.paymentId}:${b.sourceKind}:${b.refundLinkId ?? ""}`)));
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function summaryCountsMatch(run: PersistedAllocationRun): boolean {
  const summary = readRunSummary(run.summary);
  const recipientCount = run.allocationLines.reduce((count, line) => count + line.recipients.length, 0);
  return summary.allocationVersion === 2 && summary.lineCount === run.allocationLines.length && summary.recipientCount === recipientCount;
}

export async function previewInternalAllocation(
  input: AllocationPeriodInput,
  dependencies: FinanceAllocationDependencies = {}
): Promise<AllocationPreview> {
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("分配期间不正确");
  const actor = await actorOrSession(dependencies.actor);
  assertAllocationAccess(actor);
  const db = dependencies.db ?? prisma;
  const facts = await collectAllocationFacts(parsed.data, actor, db);
  const periodStart = dayStart(parsed.data.periodStart);
  const periodEnd = dayStart(parsed.data.periodEnd);
  const where = { periodStart_periodEnd_sourceHash: { periodStart, periodEnd, sourceHash: facts.sourceHash } };
  const include = { allocationLines: { include: { recipients: true, payment: { select: { occurredAt: true } } } } } as const;
  const previouslySaved = await db.financeCalculationRun.findUnique({ where, include });
  if (previouslySaved) return previewFromRun(previouslySaved as PersistedAllocationRun, parsed.data);

  try {
    return await db.$transaction(async (tx) => {
      const raced = await tx.financeCalculationRun.findUnique({ where, include });
      if (raced) return previewFromRun(raced as PersistedAllocationRun, parsed.data);

      const created = await tx.financeCalculationRun.create({
        data: {
          periodStart,
          periodEnd,
          sourceHash: facts.sourceHash,
          ruleVersionIds: facts.ruleVersionIds,
          status: "PREVIEW",
          trigger: "PREVIEW",
          summary: {
            allocationVersion: 2,
            blockingIssues: facts.blockingIssues,
            lineCount: facts.lines.length,
            recipientCount: facts.recipients.length,
            paymentCount: facts.lines.filter((line) => line.sourceKind === "PAYMENT").length,
            refundCount: facts.lines.filter((line) => line.sourceKind === "REFUND").length
          },
          createdById: actor.id
        },
        select: { id: true }
      });

      const persistedLines = facts.lines.map((line) => ({
        ...line,
        id: randomUUID(),
        runId: created.id,
        sourceOccurredAt: new Date(line.sourceOccurredAt)
      }));
      if (persistedLines.length) {
        const insertedLines = await tx.financeAllocationLine.createMany({
          data: persistedLines.map((line) => ({
            id: line.id,
            runId: line.runId,
            paymentId: line.paymentId,
            sourceKind: line.sourceKind,
            refundLinkId: line.refundLinkId,
            sourceOccurredAt: line.sourceOccurredAt,
            matterId: line.matterId,
            targetUserId: line.targetUserId,
            ruleVersionId: line.ruleVersionId,
            grossAmount: line.grossAmount,
            channelAmount: line.channelAmount,
            firmAmount: line.firmAmount,
            sourceAmount: line.sourceAmount,
            handlingAmount: line.handlingAmount,
            coAmount: line.coAmount
          }))
        });
        if (insertedLines.count !== persistedLines.length) throw new ActionError("分配行写入数量不完整，已取消预览");
      }
      if (facts.recipients.length) {
        const lineIdBySource = new Map(persistedLines.map((line) => [`${line.paymentId}:${line.sourceKind}:${line.refundLinkId ?? ""}`, line.id]));
        const recipientRows = persistedLines.flatMap((line) => line.recipients.map((recipient) => ({
          id: randomUUID(),
          allocationLineId: lineIdBySource.get(`${line.paymentId}:${line.sourceKind}:${line.refundLinkId ?? ""}`)!,
          userId: recipient.userId,
          role: recipient.role,
          shareRate: recipient.shareRate,
          amount: recipient.amount
        })));
        const insertedRecipients = await tx.financeAllocationRecipient.createMany({ data: recipientRows });
        if (insertedRecipients.count !== facts.recipients.length) throw new ActionError("人员分配写入数量不完整，已取消预览");
      }
      await auditTx(tx, {
        userId: actor.id,
        action: "FINANCE_INTERNAL_ALLOCATION_PREVIEW",
        targetType: "FinanceCalculationRun",
        targetId: created.id,
        detail: { periodStart: parsed.data.periodStart, periodEnd: parsed.data.periodEnd, blockingCount: facts.blockingIssues.length, allocationVersion: 2 }
      });
      return {
        runId: created.id,
        periodStart: parsed.data.periodStart,
        periodEnd: parsed.data.periodEnd,
        sourceHash: facts.sourceHash,
        status: "PREVIEW" as const,
        allocationVersion: 2 as const,
        blockingIssues: facts.blockingIssues,
        lines: facts.lines,
        recipients: facts.recipients
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const collision = await db.financeCalculationRun.findUnique({ where, include });
    if (!collision) throw error;
    return previewFromRun(collision as PersistedAllocationRun, parsed.data);
  }
}

export async function commitInternalAllocation(
  runId: string,
  dependencies: FinanceAllocationDependencies = {}
): Promise<{ runId: string; status: "COMMITTED" }> {
  const actor = await actorOrSession(dependencies.actor);
  assertAllocationAccess(actor);
  const db = dependencies.db ?? prisma;
  const include = { allocationLines: { include: { recipients: true, payment: { select: { occurredAt: true } } } } } as const;
  const existing = await db.financeCalculationRun.findUnique({ where: { id: runId }, include });
  if (!existing) throw new ActionError("计算批次不存在");
  if (existing.status === "COMMITTED") return { runId: existing.id, status: "COMMITTED" };
  if (existing.status !== "PREVIEW") throw new ActionError("只有预览批次可以提交");
  const run = existing as PersistedAllocationRun;
  const summary = readRunSummary(run.summary);
  if (summary.allocationVersion !== 2) throw new ActionError("旧版分配预览不可提交，请重新生成");
  if (summary.blockingIssues.length) throw new ActionError("存在阻断项，不能提交分配批次");
  if (!summaryCountsMatch(run)) throw new ActionError("预览批次记录数量异常，请重新生成");

  return db.$transaction(async (tx) => {
    const currentRun = await tx.financeCalculationRun.findUnique({ where: { id: runId }, include });
    if (!currentRun) throw new ActionError("计算批次不存在");
    if (currentRun.status === "COMMITTED") return { runId, status: "COMMITTED" as const };
    if (currentRun.status !== "PREVIEW") throw new ActionError("只有预览批次可以提交");
    const currentPersisted = currentRun as PersistedAllocationRun;
    const currentSummary = readRunSummary(currentPersisted.summary);
    if (currentSummary.blockingIssues.length) throw new ActionError("存在阻断项，不能提交分配批次");
    if (!summaryCountsMatch(currentPersisted)) throw new ActionError("预览批次记录数量异常，请重新生成");

    const current = await collectAllocationFacts(
      { periodStart: shDayKey(currentRun.periodStart), periodEnd: shDayKey(currentRun.periodEnd) },
      actor,
      tx
    );
    if (current.sourceHash !== currentRun.sourceHash) throw new ActionError("来源事实已变化，请重新生成预览");
    if (current.blockingIssues.length) throw new ActionError("存在阻断项，不能提交分配批次");
    if (current.lines.length !== currentSummary.lineCount || current.recipients.length !== currentSummary.recipientCount) {
      throw new ActionError("预览记录数量与当前来源不一致，请重新生成");
    }
    if (allocationFingerprint(current.lines) !== allocationFingerprint(currentPersisted.allocationLines)) {
      throw new ActionError("预览分配明细与当前来源不一致，请重新生成");
    }

    let snapshots: Awaited<ReturnType<typeof persistFinancePeriodSnapshots>>;
    try {
      snapshots = await persistFinancePeriodSnapshots(
        runId,
        shDayKey(currentRun.periodStart).slice(0, 7),
        current.lines,
        tx
      );
    } catch (caught) {
      if (caught instanceof Error) throw new ActionError(caught.message);
      throw caught;
    }

    const committed = await tx.financeCalculationRun.updateMany({
      where: { id: runId, status: "PREVIEW", sourceHash: currentRun.sourceHash },
      data: {
        status: "COMMITTED",
        summary: {
          allocationVersion: 2,
          blockingIssues: [],
          lineCount: current.lines.length,
          recipientCount: current.recipients.length,
          paymentCount: current.lines.filter((line) => line.sourceKind === "PAYMENT").length,
          refundCount: current.lines.filter((line) => line.sourceKind === "REFUND").length,
          personSnapshotCount: snapshots.personCount,
          firmSnapshotCount: 1,
          snapshotVersion: "personal-v1"
        }
      }
    });
    if (committed.count !== 1) throw new ActionError("批次状态已变化，请刷新后重试");
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_ALLOCATION_COMMIT",
      targetType: "FinanceCalculationRun",
      targetId: runId,
      detail: { sourceHash: currentRun.sourceHash, lineCount: current.lines.length, recipientCount: current.recipients.length, personSnapshotCount: snapshots.personCount, allocationVersion: 2, snapshotVersion: "personal-v1" }
    });
    return { runId, status: "COMMITTED" as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
