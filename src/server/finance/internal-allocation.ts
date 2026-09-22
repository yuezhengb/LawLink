import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { calculateAllocation, financeRuleDefinitionSchema } from "@/lib/finance/internal-rules";
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
  ruleVersionId: string;
  grossAmount: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
};

export type AllocationPreview = {
  runId: string;
  periodStart: string;
  periodEnd: string;
  sourceHash: string;
  status: "PREVIEW";
  blockingIssues: string[];
  lines: AllocationPreviewLine[];
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

function participantId(profile: { participantIds: unknown }, plans: Array<{ userId: string }>): string | null {
  if (Array.isArray(profile.participantIds)) {
    const first = profile.participantIds.find((item): item is string => typeof item === "string" && item.length > 0);
    if (first) return first;
  }
  return plans[0]?.userId ?? null;
}

async function collectAllocationFacts(input: AllocationPeriodInput, actor: FinanceAllocationActor, db: PrismaClient) {
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
      matter: { include: { financeMatterProfile: true, commissionPlans: true } },
      financeRefundLinks: { where: { active: true }, select: { amount: true } }
    }
  });

  const blockingIssues: string[] = [];
  const lines: AllocationPreviewLine[] = [];
  const ruleVersionIds: string[] = [];
  const hashParts: unknown[] = [];

  for (const payment of payments) {
    const profile = payment.matter.financeMatterProfile;
    const plans = payment.matter.commissionPlans;
    const refundTotal = payment.financeRefundLinks.reduce((sum, link) => sum.plus(amount(link.amount)), new Prisma.Decimal(0));
    const gross = amount(payment.amount).minus(refundTotal);
    hashParts.push({
      paymentId: payment.id,
      matterId: payment.matterId,
      amount: textAmount(payment.amount),
      refunds: textAmount(refundTotal),
      profile: profile ? { origin: profile.origin, participantIds: profile.participantIds, activeRuleSetId: profile.activeRuleSetId } : null,
      plans: plans.map((plan) => ({ userId: plan.userId, percent: textAmount(amount(plan.percent)), active: plan.active }))
    });
    if (!profile) {
      blockingIssues.push(`案件 ${payment.matterId} 缺少案件财务画像`);
      continue;
    }
    if (!plans.length || plans.some((plan) => !plan.active)) {
      blockingIssues.push(`案件 ${payment.matterId} 缺少有效分成方案`);
      continue;
    }
    if (gross.lte(0)) {
      blockingIssues.push(`付款 ${payment.id} 扣除退款后没有可分配余额`);
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
    const percentages = definition.data.percentages;
    let allocation;
    try {
      allocation = calculateAllocation({
        gross: textAmount(gross),
        channelRate: percentages.channelRate ?? "0",
        firmRate: percentages.firmRate ?? "0",
        sourceRate: percentages.sourceRate ?? "0",
        handlingRate: percentages.handlingRate ?? "0",
        coRate: percentages.coRate ?? "0"
      });
    } catch {
      blockingIssues.push(`规则 ${rule.id} 分配比例不合法`);
      continue;
    }
    ruleVersionIds.push(rule.id);
    lines.push({
      paymentId: payment.id,
      matterId: payment.matterId,
      targetUserId: participantId(profile, plans),
      ruleVersionId: rule.id,
      grossAmount: textAmount(gross),
      channelAmount: textAmount(allocation.channel),
      firmAmount: textAmount(allocation.firm),
      sourceAmount: textAmount(allocation.source),
      handlingAmount: textAmount(allocation.handling),
      coAmount: textAmount(allocation.co)
    });
  }

  const sourceHash = createHash("sha256").update(JSON.stringify({ input, hashParts }), "utf8").digest("hex");
  return { sourceHash, ruleVersionIds: [...new Set(ruleVersionIds)], blockingIssues: [...new Set(blockingIssues)], lines };
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
  const run = await db.$transaction(async (tx) => {
    const created = await tx.financeCalculationRun.create({
      data: {
        periodStart: dayStart(parsed.data.periodStart),
        periodEnd: dayStart(parsed.data.periodEnd),
        sourceHash: facts.sourceHash,
        ruleVersionIds: facts.ruleVersionIds,
        status: "PREVIEW",
        trigger: "PREVIEW",
        summary: { blockingIssues: facts.blockingIssues, lineCount: facts.lines.length },
        createdById: actor.id
      },
      select: { id: true }
    });
    if (facts.lines.length) {
      await tx.financeAllocationLine.createMany({
        data: facts.lines.map((line) => ({
          runId: created.id,
          paymentId: line.paymentId,
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
    }
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_ALLOCATION_PREVIEW",
      targetType: "FinanceCalculationRun",
      targetId: created.id,
      detail: { periodStart: parsed.data.periodStart, periodEnd: parsed.data.periodEnd, blockingCount: facts.blockingIssues.length }
    });
    return created;
  });
  return {
    runId: run.id,
    periodStart: parsed.data.periodStart,
    periodEnd: parsed.data.periodEnd,
    sourceHash: facts.sourceHash,
    status: "PREVIEW",
    blockingIssues: facts.blockingIssues,
    lines: facts.lines
  };
}

export async function commitInternalAllocation(
  runId: string,
  dependencies: FinanceAllocationDependencies = {}
): Promise<{ runId: string; status: "COMMITTED" }> {
  const actor = await actorOrSession(dependencies.actor);
  assertAllocationAccess(actor);
  const db = dependencies.db ?? prisma;
  const existing = await db.financeCalculationRun.findUnique({ where: { id: runId }, include: { allocationLines: true } });
  if (!existing) throw new ActionError("计算批次不存在");
  if (existing.status === "COMMITTED") return { runId: existing.id, status: "COMMITTED" };
  if (existing.status !== "PREVIEW") throw new ActionError("只有预览批次可以提交");

  const current = await collectAllocationFacts(
    { periodStart: shDayKey(existing.periodStart), periodEnd: shDayKey(existing.periodEnd) },
    actor,
    db
  );
  if (current.sourceHash !== existing.sourceHash) throw new ActionError("来源事实已变化，请重新生成预览");
  if (current.blockingIssues.length) throw new ActionError("存在阻断项，不能提交分配批次");

  return db.$transaction(async (tx) => {
    const committed = await tx.financeCalculationRun.update({
      where: { id: runId },
      data: { status: "COMMITTED", summary: { blockingIssues: [], lineCount: current.lines.length } },
      select: { id: true, status: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_ALLOCATION_COMMIT",
      targetType: "FinanceCalculationRun",
      targetId: runId,
      detail: { sourceHash: existing.sourceHash, lineCount: current.lines.length }
    });
    return { runId: committed.id, status: "COMMITTED" as const };
  });
}
