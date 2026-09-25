import { Prisma, type FinanceDirection, type FinanceReconciliationStatus, type PrismaClient } from "@prisma/client";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { getInternalFinanceSummary, type FinanceReportsActor, type InternalFinanceSummary } from "@/server/finance/internal-reports";
import { financePeriodBounds } from "@/server/finance/internal-workspaces";
import { getMonthlyCloseStatus, type MonthlyCloseActor, type MonthlyCloseStatus } from "@/server/finance/monthly-close";

export type InternalFinanceWorkspaceActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
type WorkspaceDb = Pick<PrismaClient, "financeSourceRow" | "financeImportBatch">;
const COUNTERPARTY_STATUSES = new Set<FinanceReconciliationStatus>(["UNRESOLVED", "SUGGESTED", "CONFIRMED", "IGNORED", "SUSPECT", "EXCEPTION"]);

export type FinanceBankSourceFacts = {
  committedBatchCount: number;
  creditRows: number;
  creditAmount: string;
  debitRows: number;
  debitAmount: string;
  unknownRows: number;
  unknownAmount: string;
  confirmedCreditRows: number;
  confirmedCreditAmount: string;
  unclaimedCreditRows: number;
  unclaimedCreditAmount: string;
};

export type InternalFinanceOverview = {
  period: string;
  closeStatus: MonthlyCloseStatus;
  officialSnapshot: null | {
    runId: string;
    feeRevenue: string;
    firmRetained: string;
    lawyerAllocation: string;
    operatingResult: string | null;
    costBreakdown: InternalFinanceSummary["firm"]["costBreakdown"];
  };
  bank: Omit<FinanceBankSourceFacts, "creditAmount" | "debitAmount" | "unknownAmount" | "confirmedCreditAmount" | "unclaimedCreditAmount"> & {
    creditAmount: string | null;
    debitAmount: string | null;
    unknownAmount: string | null;
    confirmedCreditAmount: string | null;
    unclaimedCreditAmount: string | null;
  };
};

export type FinanceCounterpartyItem = {
  digest: string;
  display: string | null;
  creditRows: number;
  creditAmount: string;
  debitRows: number;
  debitAmount: string;
  unknownRows: number;
  unknownAmount: string;
  confirmedCreditRows: number;
  confirmedCreditAmount: string;
  unclaimedCreditRows: number;
  unclaimedCreditAmount: string;
};

function assertRead(actor: InternalFinanceWorkspaceActor): "ALL" | "OWN" {
  if (actor.role === "FINANCE") return "ALL";
  if (actor.role === "CUSTOM") {
    const scope = scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read");
    if (scope === "ALL" || scope === "OWN") return scope;
  }
  throw new ActionError("无内部财务查看权限");
}

function assertReadAll(actor: InternalFinanceWorkspaceActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read") === "ALL") return;
  throw new ActionError("无全所财务透视权限");
}

export function canReadAllInternalFinance(actor: InternalFinanceWorkspaceActor): boolean {
  if (actor.role === "FINANCE") return true;
  return actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read") === "ALL";
}

function fixed(value: unknown): string {
  return new Prisma.Decimal(String(value ?? "0")).toFixed(2);
}

function aggregateByDirection(groups: Array<{ direction: FinanceDirection; _count: { _all: number }; _sum: { amount: unknown } }>) {
  const find = (direction: FinanceDirection) => groups.find((group) => group.direction === direction);
  const credit = find("CREDIT");
  const debit = find("DEBIT");
  const unknown = find("UNKNOWN");
  return {
    creditRows: credit?._count._all ?? 0,
    creditAmount: fixed(credit?._sum.amount),
    debitRows: debit?._count._all ?? 0,
    debitAmount: fixed(debit?._sum.amount),
    unknownRows: unknown?._count._all ?? 0,
    unknownAmount: fixed(unknown?._sum.amount)
  };
}

function bankRowWhere(start: Date, end: Date, actor: InternalFinanceWorkspaceActor, scope: "ALL" | "OWN"): Prisma.FinanceSourceRowWhereInput {
  return {
    occurredAt: { gte: start, lt: end },
    batch: { is: { status: "COMMITTED", kind: "BANK_STATEMENT", ...(scope === "OWN" ? { createdById: actor.id } : {}) } }
  };
}

async function bankFacts(period: string, actor: InternalFinanceWorkspaceActor, scope: "ALL" | "OWN", db: WorkspaceDb): Promise<FinanceBankSourceFacts> {
  const { start, end } = financePeriodBounds(period);
  const base = bankRowWhere(start, end, actor, scope);
  const ownBatch = scope === "OWN" ? { createdById: actor.id } : {};
  const [batchCount, groups, confirmed, unclaimed] = await Promise.all([
    db.financeImportBatch.count({
      where: {
        status: "COMMITTED", kind: "BANK_STATEMENT", ...ownBatch,
        sourceRows: { some: { occurredAt: { gte: start, lt: end } } }
      }
    }),
    db.financeSourceRow.groupBy({ by: ["direction"], where: base, _count: { _all: true }, _sum: { amount: true } }),
    db.financeSourceRow.groupBy({
      by: ["direction"],
      where: { ...base, direction: "CREDIT", reconciliationCase: { is: { status: "CONFIRMED", paymentId: { not: null } } } },
      _count: { _all: true }, _sum: { amount: true }
    }),
    db.financeSourceRow.groupBy({
      by: ["direction"],
      where: { ...base, direction: "CREDIT", reconciliationCase: { is: { status: { in: ["UNRESOLVED", "SUGGESTED"] } } } },
      _count: { _all: true }, _sum: { amount: true }
    })
  ]);
  const all = aggregateByDirection(groups);
  const confirmedAggregate = aggregateByDirection(confirmed);
  const unclaimedAggregate = aggregateByDirection(unclaimed);
  return {
    committedBatchCount: batchCount,
    ...all,
    confirmedCreditRows: confirmedAggregate.creditRows,
    confirmedCreditAmount: confirmedAggregate.creditAmount,
    unclaimedCreditRows: unclaimedAggregate.creditRows,
    unclaimedCreditAmount: unclaimedAggregate.creditAmount
  };
}

export function buildInternalFinanceOverview(input: {
  period: string;
  closeStatus: MonthlyCloseStatus;
  summary: InternalFinanceSummary;
  bank: FinanceBankSourceFacts;
}): InternalFinanceOverview {
  const snapshot = input.summary.calculationRunId ? {
    runId: input.summary.calculationRunId,
    feeRevenue: input.summary.firm.feeRevenue,
    firmRetained: input.summary.firm.firmAmount,
    lawyerAllocation: input.summary.firm.lawyerAmount,
    operatingResult: input.summary.firm.operatingResult,
    costBreakdown: input.summary.firm.costBreakdown
  } : null;
  const hasCommittedSource = input.bank.committedBatchCount > 0;
  return {
    period: input.period,
    closeStatus: input.closeStatus,
    officialSnapshot: snapshot,
    bank: {
      ...input.bank,
      creditAmount: hasCommittedSource ? input.bank.creditAmount : null,
      debitAmount: hasCommittedSource ? input.bank.debitAmount : null,
      unknownAmount: hasCommittedSource ? input.bank.unknownAmount : null,
      confirmedCreditAmount: hasCommittedSource ? input.bank.confirmedCreditAmount : null,
      unclaimedCreditAmount: hasCommittedSource ? input.bank.unclaimedCreditAmount : null
    }
  };
}

export async function getInternalFinanceOverview(
  period: string,
  actor: InternalFinanceWorkspaceActor,
  dependencies: {
    db?: WorkspaceDb;
    getSummary?: (period: string, actor: InternalFinanceWorkspaceActor) => Promise<InternalFinanceSummary>;
    getCloseStatus?: (period: string, actor: InternalFinanceWorkspaceActor) => Promise<MonthlyCloseStatus>;
  } = {}
): Promise<InternalFinanceOverview> {
  const scope = assertRead(actor);
  const { start, end } = financePeriodBounds(period);
  const db = dependencies.db ?? prisma;
  const getSummary = dependencies.getSummary ?? ((value, user) => getInternalFinanceSummary(
    { start, end, groupBy: "ALL" }, { actor: user as FinanceReportsActor }
  ));
  const getCloseStatus = dependencies.getCloseStatus ?? ((value, user) => getMonthlyCloseStatus(value, { actor: user as MonthlyCloseActor }));
  const [summary, closeStatus, bank] = await Promise.all([
    getSummary(period, actor),
    getCloseStatus(period, actor),
    bankFacts(period, actor, scope, db)
  ]);
  return buildInternalFinanceOverview({ period, closeStatus, summary, bank });
}

type CounterpartyAggregate = {
  counterpartyDigest: string;
  direction: FinanceDirection;
  _count: { _all: number };
  _sum: { amount: unknown };
};

function statusWhere(status?: FinanceReconciliationStatus): Prisma.FinanceSourceRowWhereInput {
  return status ? { reconciliationCase: { is: { status } } } : {};
}

function emptyGroup(): FinanceCounterpartyItem {
  return {
    digest: "", display: null,
    creditRows: 0, creditAmount: "0.00", debitRows: 0, debitAmount: "0.00", unknownRows: 0, unknownAmount: "0.00",
    confirmedCreditRows: 0, confirmedCreditAmount: "0.00", unclaimedCreditRows: 0, unclaimedCreditAmount: "0.00"
  };
}

function appendCounterpartyGroups(map: Map<string, FinanceCounterpartyItem>, groups: CounterpartyAggregate[]) {
  for (const group of groups) {
    const item = map.get(group.counterpartyDigest);
    if (!item) continue;
    const rows = group._count._all;
    const amount = fixed(group._sum.amount);
    if (group.direction === "CREDIT") { item.creditRows = rows; item.creditAmount = amount; }
    else if (group.direction === "DEBIT") { item.debitRows = rows; item.debitAmount = amount; }
    else { item.unknownRows = rows; item.unknownAmount = amount; }
  }
}

export async function listFinanceCounterparties(
  input: { period: string; direction?: FinanceDirection; status?: FinanceReconciliationStatus; cursor?: string; pageSize?: number },
  actor: InternalFinanceWorkspaceActor,
  dependencies: { db?: WorkspaceDb } = {}
): Promise<{ items: FinanceCounterpartyItem[]; hasMore: boolean; nextCursor: string | null }> {
  assertReadAll(actor);
  const { start, end } = financePeriodBounds(input.period);
  if (input.direction && !["CREDIT", "DEBIT", "UNKNOWN"].includes(input.direction)) throw new ActionError("收付方向不正确");
  if (input.status && !COUNTERPARTY_STATUSES.has(input.status)) throw new ActionError("对账状态不正确");
  if (input.cursor && (input.cursor.length > 128 || !input.cursor.trim())) throw new ActionError("分页游标不正确");
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 50)));
  const db = dependencies.db ?? prisma;
  const commonWhere: Prisma.FinanceSourceRowWhereInput = {
    occurredAt: { gte: start, lt: end },
    batch: { is: { status: "COMMITTED", kind: "BANK_STATEMENT" } },
    counterpartyDigest: { not: null, ...(input.cursor ? { gt: input.cursor } : {}) },
    ...(input.direction ? { direction: input.direction } : {}),
    ...statusWhere(input.status)
  };
  const digestGroups = await db.financeSourceRow.groupBy({
    by: ["counterpartyDigest"], where: commonWhere, orderBy: { counterpartyDigest: "asc" }, take: pageSize + 1
  });
  const hasMore = digestGroups.length > pageSize;
  const pageDigests = digestGroups.slice(0, pageSize).map((group) => group.counterpartyDigest).filter((value): value is string => Boolean(value));
  if (!pageDigests.length) return { items: [], hasMore: false, nextCursor: null };

  const digestWhere = { counterpartyDigest: { in: pageDigests } };
  const allWhere = { ...commonWhere, ...digestWhere };
  const confirmedAllowed = !input.status || input.status === "CONFIRMED";
  const unclaimedAllowed = !input.status || input.status === "UNRESOLVED" || input.status === "SUGGESTED";
  const [allGroups, confirmedGroups, unclaimedGroups, displays] = await Promise.all([
    db.financeSourceRow.groupBy({ by: ["counterpartyDigest", "direction"], where: allWhere, _count: { _all: true }, _sum: { amount: true } }),
    confirmedAllowed ? db.financeSourceRow.groupBy({
      by: ["counterpartyDigest", "direction"],
      where: { ...commonWhere, ...digestWhere, direction: "CREDIT", reconciliationCase: { is: { status: "CONFIRMED", paymentId: { not: null } } } },
      _count: { _all: true }, _sum: { amount: true }
    }) : Promise.resolve([]),
    unclaimedAllowed ? db.financeSourceRow.groupBy({
      by: ["counterpartyDigest", "direction"],
      where: { ...commonWhere, ...digestWhere, direction: "CREDIT", reconciliationCase: { is: { status: input.status ?? { in: ["UNRESOLVED", "SUGGESTED"] } } } },
      _count: { _all: true }, _sum: { amount: true }
    }) : Promise.resolve([]),
    db.financeSourceRow.findMany({
      where: allWhere,
      distinct: ["counterpartyDigest"],
      orderBy: [{ counterpartyDigest: "asc" }, { sourceRow: "asc" }],
      select: { counterpartyDigest: true, counterpartyDisplay: true }
    })
  ]);
  const items = new Map(pageDigests.map((digest) => [digest, { ...emptyGroup(), digest }]));
  appendCounterpartyGroups(items, allGroups as CounterpartyAggregate[]);
  for (const group of confirmedGroups as CounterpartyAggregate[]) {
    const item = items.get(group.counterpartyDigest);
    if (item && group.direction === "CREDIT") { item.confirmedCreditRows = group._count._all; item.confirmedCreditAmount = fixed(group._sum.amount); }
  }
  for (const group of unclaimedGroups as CounterpartyAggregate[]) {
    const item = items.get(group.counterpartyDigest);
    if (item && group.direction === "CREDIT") { item.unclaimedCreditRows = group._count._all; item.unclaimedCreditAmount = fixed(group._sum.amount); }
  }
  for (const row of displays) {
    const item = row.counterpartyDigest ? items.get(row.counterpartyDigest) : undefined;
    if (item && item.display === null) item.display = row.counterpartyDisplay;
  }
  const pageItems = pageDigests.map((digest) => items.get(digest)!).filter(Boolean);
  return { items: pageItems, hasMore, nextCursor: hasMore ? pageDigests.at(-1) ?? null : null };
}
