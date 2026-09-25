import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { rowFingerprint } from "@/lib/finance/source-fingerprint";
import { rankPaymentCandidates, rankRefundCandidates } from "@/lib/finance/internal-matching";
import type {
  ConfirmedPaymentCandidate,
  FinanceMatchStatus,
  FinanceNormalizedRow,
  FinanceMatchSuggestion,
  FinanceSourceKind,
  ReconciliationDecisionInput,
  ReconciliationQuery,
  ReconciliationQueue,
  RefundPaymentCandidate,
  RefundLinkInput
} from "@/lib/finance/internal-types";
import type { PrismaClient } from "@prisma/client";

export type FinanceReconciliationActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceReconciliationDependencies = {
  db?: PrismaClient;
  actor?: FinanceReconciliationActor;
};

function actorOrSession(actor?: FinanceReconciliationActor): Promise<FinanceReconciliationActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.reconcile").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function canReadReconciliation(actor: FinanceReconciliationActor): boolean {
  if (actor.role === "FINANCE") return true;
  if (actor.role !== "CUSTOM") return false;
  const grantsUser = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
  return Boolean(scopeFor(grantsUser, "finance.read") && scopeFor(grantsUser, "finance.reconcile"));
}

function assertReconciliationAccess(actor: FinanceReconciliationActor): void {
  if (!canReadReconciliation(actor)) throw new ActionError("无财务对账权限");
}

function asMoney(value: unknown): string {
  if (value instanceof Prisma.Decimal) return value.toFixed(2);
  if (value && typeof value === "object" && "toFixed" in value && typeof value.toFixed === "function") return value.toFixed(2);
  return new Prisma.Decimal(String(value ?? "0")).toFixed(2);
}

function sourceToNormalizedRow(source: {
  id: string;
  batchId: string;
  sourceSheet?: string;
  sourceRow: number;
  occurredAt: Date;
  amount: unknown;
  direction: string;
  balance?: unknown;
  counterpartyDigest?: string | null;
  counterpartyDisplay?: string | null;
  accountMasked?: string | null;
  descriptionDigest?: string | null;
  descriptionDisplay?: string | null;
  externalReference?: string | null;
  invoiceReference?: string | null;
  metadata?: unknown;
}): FinanceNormalizedRow {
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata as { sourceKind?: unknown } : null;
  const sourceKind = typeof metadata?.sourceKind === "string" ? metadata.sourceKind as FinanceSourceKind : "BANK_STATEMENT";
  return {
    sourceKind,
    sourceBatchId: source.batchId,
    sourceFileId: undefined,
    sourceSheet: source.sourceSheet ?? "",
    sourceRowNumber: source.sourceRow,
    occurredAt: shDayKey(source.occurredAt),
    amount: asMoney(source.amount),
    direction: source.direction as FinanceNormalizedRow["direction"],
    balance: source.balance === null || source.balance === undefined ? null : asMoney(source.balance),
    counterparty: source.counterpartyDisplay ?? null,
    counterpartyDigest: source.counterpartyDigest ?? null,
    accountMasked: source.accountMasked ?? null,
    description: source.descriptionDisplay ?? null,
    descriptionDigest: source.descriptionDigest ?? null,
    externalReference: source.externalReference ?? null,
    invoiceReference: source.invoiceReference ?? null
  };
}

function paymentToCandidate(payment: {
  id: string;
  matterId: string;
  feeEntryId: string;
  amount: unknown;
  occurredAt: Date;
  moneyKind: string;
  sourceEntry?: { confirmState?: string; invoiceNo?: string | null } | null;
}): ConfirmedPaymentCandidate {
  return {
    paymentId: payment.id,
    matterId: payment.matterId,
    feeEntryId: payment.feeEntryId,
    amount: asMoney(payment.amount),
    occurredAt: shDayKey(payment.occurredAt),
    moneyKind: payment.moneyKind as "LAWYER_FEE",
    confirmState: payment.sourceEntry?.confirmState as "CONFIRMED",
    invoiceReference: payment.sourceEntry?.invoiceNo ?? null
  };
}

function dateFilter(input: ReconciliationQuery): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (input.periodStart) result.gte = new Date(`${input.periodStart}T00:00:00+08:00`);
  if (input.periodEnd) result.lt = new Date(`${input.periodEnd}T00:00:00+08:00`);
  return Object.keys(result).length ? result : {};
}

export async function listFinanceReconciliationCases(
  input: ReconciliationQuery,
  dependencies: FinanceReconciliationDependencies = {}
): Promise<ReconciliationQueue> {
  const actor = await actorOrSession(dependencies.actor);
  assertReconciliationAccess(actor);
  const db = dependencies.db ?? prisma;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));
  const sourceWhere = Object.keys(dateFilter(input)).length ? { occurredAt: dateFilter(input) } : {};
  const cases = await db.financeReconciliationCase.findMany({
    where: {
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.status ? { status: input.status } : {}),
      sourceRow: sourceWhere
    },
    include: { sourceRow: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize
  });

  const hasCreditCases = cases.some((item) => item.sourceRow.direction === "CREDIT");
  const candidates = hasCreditCases ? await db.payment.findMany({
    where: {
      moneyKind: "LAWYER_FEE",
      sourceEntry: { confirmState: "CONFIRMED" },
      matter: {
        deletedAt: null,
        ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
      },
      financeReconciliationCases: { none: { status: "CONFIRMED" } }
    },
    select: {
      id: true,
      matterId: true,
      feeEntryId: true,
      amount: true,
      occurredAt: true,
      moneyKind: true,
      sourceEntry: { select: { confirmState: true, invoiceNo: true } }
    }
  }) : [];
  const candidateRows = candidates.map(paymentToCandidate);
  const hasDebitCases = cases.some((item) => item.sourceRow.direction === "DEBIT");
  const refundRows = hasDebitCases ? await db.payment.findMany({
    where: {
      moneyKind: "LAWYER_FEE",
      refundedAmount: { gt: 0 },
      sourceEntry: { confirmState: "CONFIRMED" },
      matter: {
        deletedAt: null,
        ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
      }
    },
    select: {
      id: true,
      occurredAt: true,
      refundedAmount: true,
      financeRefundLinks: { where: { active: true }, select: { amount: true } },
      matter: { select: { internalCode: true } }
    }
  }) : [];
  const refundCandidates: RefundPaymentCandidate[] = refundRows.map((payment) => ({
    paymentId: payment.id,
    matterCode: payment.matter.internalCode,
    occurredAt: shDayKey(payment.occurredAt),
    refundedAmount: asMoney(payment.refundedAmount),
    linkedRefundAmount: asMoney(payment.financeRefundLinks.reduce((sum, link) => sum.plus(new Prisma.Decimal(link.amount)), new Prisma.Decimal(0)))
  }));
  const items = cases.map((item) => {
    const row = sourceToNormalizedRow(item.sourceRow);
    const suggestions = row.direction === "DEBIT"
      ? rankRefundCandidates(row, refundCandidates)
      : rankPaymentCandidates(row, candidateRows);
    return {
      id: item.id,
      sourceRowId: item.sourceRow.id,
      status: item.status as FinanceMatchStatus,
      row,
      suggestions
    };
  });
  const count = "count" in db.financeReconciliationCase && typeof db.financeReconciliationCase.count === "function"
    ? await db.financeReconciliationCase.count({
        where: {
          ...(input.batchId ? { batchId: input.batchId } : {}),
          ...(input.status ? { status: input.status } : {}),
          sourceRow: sourceWhere
        }
      })
    : cases.length;
  return { items, total: count };
}

function desiredStatus(decision: ReconciliationDecisionInput["decision"]): "CONFIRMED" | "IGNORED" | "SUSPECT" {
  return decision === "CONFIRM" ? "CONFIRMED" : decision === "IGNORE" ? "IGNORED" : "SUSPECT";
}

function finalStatus(status: string): boolean {
  return status === "CONFIRMED" || status === "IGNORED";
}

export async function decideFinanceReconciliation(
  input: ReconciliationDecisionInput,
  dependencies: FinanceReconciliationDependencies = {}
): Promise<{ caseId: string; status: FinanceMatchStatus }> {
  const actor = await actorOrSession(dependencies.actor);
  assertReconciliationAccess(actor);
  if (!input.caseId || !["CONFIRM", "IGNORE", "SUSPECT"].includes(input.decision)) {
    throw new ActionError("对账决定不正确");
  }
  if ((input.decision === "IGNORE" || input.decision === "SUSPECT") && !input.reason?.trim()) {
    throw new ActionError("忽略或标记疑点时必须填写理由");
  }
  const db = dependencies.db ?? prisma;
  const targetStatus = desiredStatus(input.decision);
  return db.$transaction(async (tx) => {
    const current = await tx.financeReconciliationCase.findUnique({
      where: { id: input.caseId },
      include: { sourceRow: true }
    });
    if (!current) throw new ActionError("对账案例不存在");
    if (finalStatus(current.status)) {
      if (current.status === targetStatus && (!input.paymentId || current.paymentId === input.paymentId)) {
        return { caseId: current.id, status: current.status as FinanceMatchStatus };
      }
      throw new ActionError("该对账案例已经处理，不能重复改写");
    }

    if (input.decision === "CONFIRM") {
      if (!input.paymentId) throw new ActionError("确认对账必须选择已确认收款");
      const payment = await tx.payment.findFirst({
        where: {
          id: input.paymentId,
          moneyKind: "LAWYER_FEE",
          sourceEntry: { confirmState: "CONFIRMED" },
          matter: {
            deletedAt: null,
            ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
          }
        },
        select: { id: true }
      });
      if (!payment) throw new ActionError("只能确认可见且已确认的律师费收款");
      const used = await tx.financeReconciliationCase.findFirst({
        where: { paymentId: input.paymentId, status: "CONFIRMED", id: { not: input.caseId } },
        select: { id: true }
      });
      if (used) throw new ActionError("该付款已被其他对账案例确认");
    }

    await tx.financeClaimDecision.create({
      data: {
        caseId: input.caseId,
        decision: input.decision,
        paymentId: input.paymentId ?? null,
        reason: input.reason?.trim() || null,
        decidedById: actor.id
      }
    });
    await tx.financeReconciliationCase.update({
      where: { id: input.caseId },
      data: {
        status: targetStatus,
        ...(input.decision === "CONFIRM" ? { paymentId: input.paymentId } : {}),
        reason: input.reason?.trim() || null
      }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_RECONCILIATION_DECISION",
      targetType: "FinanceReconciliationCase",
      targetId: input.caseId,
      detail: { decision: input.decision, paymentId: input.paymentId ?? null }
    });
    return { caseId: input.caseId, status: targetStatus };
  });
}

export async function linkFinanceRefund(
  input: RefundLinkInput,
  dependencies: FinanceReconciliationDependencies = {}
): Promise<{ linkId: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertReconciliationAccess(actor);
  if (!input.sourceRowId || !input.paymentId || !input.reason?.trim()) throw new ActionError("退款关联信息不完整");
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(input.amount);
  } catch {
    throw new ActionError("退款关联金额不正确");
  }
  if (!amount.gt(0)) throw new ActionError("退款关联金额必须大于零");

  const db = dependencies.db ?? prisma;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinanceSourceRow" WHERE id=${input.sourceRowId} FOR UPDATE`;
    const source = await tx.financeSourceRow.findUnique({
      where: { id: input.sourceRowId },
      include: { reconciliationCase: true }
    });
    if (!source || !source.reconciliationCase) throw new ActionError("来源行不存在或尚未生成对账案例");
    if (source.reconciliationCase.status === "IGNORED") throw new ActionError("已忽略的对账来源不能再关联退款");
    if (source.reconciliationCase.status === "CONFIRMED" && source.reconciliationCase.paymentId && source.reconciliationCase.paymentId !== input.paymentId) {
      throw new ActionError("该来源已关联到其他付款，不能改作退款");
    }
    const sourceAmount = new Prisma.Decimal(source.amount);
    if (source.direction !== "DEBIT" || !sourceAmount.lt(0) || !amount.eq(sourceAmount.abs())) {
      throw new ActionError("退款关联金额必须等于退款来源行金额");
    }
    const active = await tx.financeRefundLink.findFirst({
      where: { sourceRowId: input.sourceRowId, active: true },
      select: { id: true, paymentId: true, amount: true }
    });
    if (active) {
      if (active.paymentId === input.paymentId && new Prisma.Decimal(active.amount).eq(amount)) return { linkId: active.id };
      throw new ActionError("该来源行已有有效退款关联");
    }
    const paymentWhere = {
      id: input.paymentId,
      moneyKind: "LAWYER_FEE" as const,
      sourceEntry: { confirmState: "CONFIRMED" as const },
      matter: {
        deletedAt: null,
        ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
      }
    };
    const visiblePayment = await tx.payment.findFirst({
      where: paymentWhere,
      select: { id: true }
    });
    if (!visiblePayment) throw new ActionError("退款只能关联可见且已确认的律师费收款");
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${input.paymentId} FOR UPDATE`;
    const payment = await tx.payment.findFirst({
      where: paymentWhere,
      select: { id: true, amount: true, refundedAmount: true }
    });
    if (!payment) throw new ActionError("原律师费收款已变化，请刷新后重试");
    const existingLinks = await tx.financeRefundLink.findMany({ where: { paymentId: input.paymentId, active: true }, select: { amount: true } });
    const alreadyLinked = existingLinks.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.amount)), new Prisma.Decimal(0));
    const totalLinked = alreadyLinked.plus(amount);
    if (totalLinked.gt(new Prisma.Decimal(payment.refundedAmount)) || totalLinked.gt(new Prisma.Decimal(payment.amount))) {
      throw new ActionError("尚未完整登记退款冲销，退款关联金额超过收款已登记退款金额");
    }

    const link = await tx.financeRefundLink.create({
      data: {
        caseId: source.reconciliationCase.id,
        sourceRowId: input.sourceRowId,
        paymentId: input.paymentId,
        amount,
        reason: input.reason.trim(),
        createdById: actor.id
      },
      select: { id: true }
    });
    if (source.reconciliationCase.status !== "CONFIRMED") {
      const note = `退款关联：${input.reason.trim()}`;
      await tx.financeClaimDecision.create({
        data: { caseId: source.reconciliationCase.id, decision: "CONFIRM", paymentId: input.paymentId, reason: note, decidedById: actor.id }
      });
      await tx.financeReconciliationCase.update({
        where: { id: source.reconciliationCase.id },
        data: { status: "CONFIRMED", paymentId: input.paymentId, reason: note }
      });
    }
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_REFUND_LINK",
      targetType: "FinanceRefundLink",
      targetId: link.id,
      detail: { sourceRowId: input.sourceRowId, paymentId: input.paymentId, amount: amount.toFixed(2) }
    });
    return { linkId: link.id };
  });
}

function maskIdentifier(value: string): string {
  return `****${value.slice(-6)}`;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function suggestionsFromJson(value: unknown): FinanceMatchSuggestion[] {
  return Array.isArray(value) ? value.filter((item): item is FinanceMatchSuggestion => Boolean(item && typeof item === "object" && "paymentId" in item)) : [];
}

export async function exportClaimDecisions(
  input: ReconciliationQuery,
  dependencies: FinanceReconciliationDependencies = {}
): Promise<Buffer> {
  const actor = await actorOrSession(dependencies.actor);
  assertReconciliationAccess(actor);
  const db = dependencies.db ?? prisma;
  const cases = await db.financeReconciliationCase.findMany({
    where: {
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.status ? { status: input.status } : {}),
      sourceRow: Object.keys(dateFilter(input)).length ? { occurredAt: dateFilter(input) } : {}
    },
    include: { sourceRow: true, claimDecisions: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const header = ["批次ID", "来源行ID（掩码）", "来源工作表", "来源行号", "来源行指纹", "日期", "有符号金额", "候选付款ID（掩码）", "决定", "理由"];
  const lines = cases.map((item) => {
    const row = sourceToNormalizedRow(item.sourceRow);
    const suggestions = suggestionsFromJson(item.suggestions);
    const latest = item.claimDecisions[0];
    return [
      item.batchId,
      maskIdentifier(item.sourceRow.id),
      item.sourceRow.sourceSheet,
      item.sourceRow.sourceRow,
      rowFingerprint(row),
      row.occurredAt,
      row.amount,
      suggestions.map((suggestion) => maskIdentifier(suggestion.paymentId)).join(";"),
      latest?.decision ?? "",
      (latest?.reason ?? item.reason ?? "").slice(0, 200)
    ].map(csvEscape).join(",");
  });
  return Buffer.from(`\uFEFF${[header.join(","), ...lines].join("\r\n")}`, "utf8");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const content = text.replace(/^\uFEFF/, "");
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\r" || character === "\n") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function importHeaderIndex(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header.replace(/\s+/g, "").toLocaleLowerCase()));
}

export async function importClaimDecisions(
  file: File,
  dependencies: FinanceReconciliationDependencies = {}
): Promise<{ applied: number; skipped: number; errors: number }> {
  const actor = await actorOrSession(dependencies.actor);
  assertReconciliationAccess(actor);
  const rows = parseCsv(Buffer.from(await file.arrayBuffer()).toString("utf8"));
  if (rows.length < 2) throw new ActionError("决定文件没有数据行");
  const headers = rows[0].map((header) => header.trim().toLocaleLowerCase());
  const batchIndex = importHeaderIndex(headers, ["批次id", "batchid"]);
  const sourceSheetIndex = importHeaderIndex(headers, ["来源工作表", "sourcesheet"]);
  const sourceRowIndex = importHeaderIndex(headers, ["来源行号", "sourcerow"]);
  const fingerprintIndex = importHeaderIndex(headers, ["来源行指纹", "rowfingerprint"]);
  const decisionIndex = importHeaderIndex(headers, ["决定", "decision"]);
  const paymentIndex = importHeaderIndex(headers, ["付款id", "paymentid"]);
  const reasonIndex = importHeaderIndex(headers, ["理由", "reason"]);
  if ([batchIndex, sourceRowIndex, fingerprintIndex, decisionIndex].some((index) => index < 0)) {
    throw new ActionError("决定文件缺少批次、来源行号、行指纹或决定列");
  }

  const db = dependencies.db ?? prisma;
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  for (const values of rows.slice(1)) {
    const batchId = values[batchIndex]?.trim();
    const sourceSheet = sourceSheetIndex >= 0 ? values[sourceSheetIndex]?.trim() ?? "" : "";
    const sourceRow = Number(values[sourceRowIndex]);
    const fingerprint = values[fingerprintIndex]?.trim();
    const decision = values[decisionIndex]?.trim().toUpperCase();
    if (!batchId || !Number.isInteger(sourceRow) || !fingerprint || !["CONFIRM", "IGNORE", "SUSPECT"].includes(decision)) {
      errors += 1;
      continue;
    }
    const source = await db.financeSourceRow.findUnique({
      where: { batchId_sourceSheet_sourceRow: { batchId, sourceSheet, sourceRow } },
      include: { reconciliationCase: true }
    });
    if (!source?.reconciliationCase) {
      errors += 1;
      continue;
    }
    const currentRow = sourceToNormalizedRow(source);
    if (rowFingerprint(currentRow) !== fingerprint) {
      errors += 1;
      continue;
    }
    if (finalStatus(source.reconciliationCase.status)) {
      skipped += 1;
      continue;
    }
    try {
      await decideFinanceReconciliation(
        {
          caseId: source.reconciliationCase.id,
          decision: decision as ReconciliationDecisionInput["decision"],
          paymentId: values[paymentIndex]?.trim() || undefined,
          reason: values[reasonIndex]?.trim() || undefined
        },
        dependencies
      );
      applied += 1;
    } catch {
      errors += 1;
    }
  }
  return { applied, skipped, errors };
}
