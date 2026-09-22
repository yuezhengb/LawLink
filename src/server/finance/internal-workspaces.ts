import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { shDayKey, shParts } from "@/lib/ui/sh-time";
import { buildPersonalDoubleBalance } from "@/lib/finance/internal-accounting";
import { getInternalAccounting } from "@/server/finance/internal-accounting-actions";
import { getInternalFinanceSummary } from "@/server/finance/internal-reports";
import { listFinanceReconciliationCases } from "@/server/finance/internal-reconciliation";
import { getMonthlyCloseStatus, type MonthlyCloseActor } from "@/server/finance/monthly-close";
import { requireSession } from "@/lib/auth/session";
import type { FinanceReportsActor } from "@/server/finance/internal-reports";
import type { FinanceReconciliationActor } from "@/server/finance/internal-reconciliation";
import type { FinanceAccountingActor } from "@/server/finance/internal-accounting-actions";
import type {
  InternalImportBatch,
  InternalLedgerView,
  InternalRuleSet,
  MonthlyCloseAdjustment,
  MonthlyCloseArtifact,
  MonthlyCloseWorkspaceData,
  ReconciliationWorkspaceQueue
} from "@/app/(app)/finance/internal/_components/types";
import type { RoleGrant } from "@/lib/roles/catalog";

export type InternalFinanceActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export function currentFinancePeriod(value = new Date()): string {
  const parts = shParts(value);
  return `${parts.y}-${String(parts.m).padStart(2, "0")}`;
}

export function financePeriodBounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error("期间必须是 YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    start: new Date(`${period}-01T00:00:00+08:00`),
    end: new Date(`${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00+08:00`)
  };
}

function fixed(value: unknown): string {
  return new Prisma.Decimal(String(value ?? "0")).toFixed(2);
}

function toSerializableDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export async function listInternalImportBatches(dependencies: { db?: typeof prisma } = {}): Promise<InternalImportBatch[]> {
  const db = dependencies.db ?? prisma;
  const rows = await db.financeImportBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, kind: true, fileName: true, status: true, periodStart: true, periodEnd: true, rowCount: true, errorCount: true, createdAt: true }
  });
  return rows.map((row) => ({ ...row, kind: String(row.kind), status: String(row.status), periodStart: toSerializableDate(row.periodStart), periodEnd: toSerializableDate(row.periodEnd), createdAt: row.createdAt.toISOString() }));
}

export async function getInternalReconciliationQueue(period: string, actor: InternalFinanceActor): Promise<ReconciliationWorkspaceQueue> {
  const { start, end } = financePeriodBounds(period);
  const queue = await listFinanceReconciliationCases({ status: "UNRESOLVED", periodStart: shDayKey(start), periodEnd: shDayKey(end), page: 1, pageSize: 100 }, { actor: actor as FinanceReconciliationActor });
  return queue;
}

export async function getInternalLedgerView(period: string, actor: InternalFinanceActor): Promise<InternalLedgerView> {
  const { start, end } = financePeriodBounds(period);
  const [summary, accounting] = await Promise.all([
    getInternalFinanceSummary({ start, end, groupBy: "ALL" }, { actor: actor as FinanceReportsActor }),
    getInternalAccounting({ period }, { actor: actor as FinanceAccountingActor })
  ]);
  const balances = new Map<string, { selfCostDue: Prisma.Decimal; selfFundingIn: Prisma.Decimal; withdrawn: Prisma.Decimal; partnerTaxAdvance: Prisma.Decimal }>();
  for (const raw of accounting.ledgerEntries) {
    const entry = raw as { targetUserId?: string; kind?: string; amount?: unknown };
    if (!entry.targetUserId) continue;
    const current = balances.get(entry.targetUserId) ?? { selfCostDue: new Prisma.Decimal(0), selfFundingIn: new Prisma.Decimal(0), withdrawn: new Prisma.Decimal(0), partnerTaxAdvance: new Prisma.Decimal(0) };
    const amount = new Prisma.Decimal(String(entry.amount ?? "0"));
    if (entry.kind === "SELF_COST") current.selfCostDue = current.selfCostDue.plus(amount);
    if (entry.kind === "SELF_FUNDING_IN") current.selfFundingIn = current.selfFundingIn.plus(amount);
    if (entry.kind === "INCOME_WITHDRAWAL") current.withdrawn = current.withdrawn.plus(amount);
    if (entry.kind === "PARTNER_TAX_ADVANCE") current.partnerTaxAdvance = current.partnerTaxAdvance.plus(amount);
    balances.set(entry.targetUserId, current);
  }
  const personalBalances = summary.persons.flatMap((person) => {
    if (!person.userId) return [];
    const input = balances.get(person.userId) ?? { selfCostDue: new Prisma.Decimal(0), selfFundingIn: new Prisma.Decimal(0), withdrawn: new Prisma.Decimal(0), partnerTaxAdvance: new Prisma.Decimal(0) };
    try {
      const result = buildPersonalDoubleBalance({ openingDistributable: "0.00", openingReserve: "0.00", earnedIncome: new Prisma.Decimal(person.sourceAmount).plus(person.handlingAmount).plus(person.coAmount).toFixed(2), selfCostDue: input.selfCostDue.toFixed(2), selfFundingIn: input.selfFundingIn.toFixed(2), withdrawn: input.withdrawn.toFixed(2), partnerTaxAdvance: input.partnerTaxAdvance.toFixed(2), unsettledHold: "0.00" });
      return [{ userId: person.userId, userName: person.userName, distributableEnd: result.distributableEnd, selfFundingReserveEnd: result.selfFundingReserveEnd, reserveGap: result.reserveGap }];
    } catch {
      return [];
    }
  });
  return {
    calculationRunId: summary.calculationRunId,
    periodStart: summary.sourcePeriod.start,
    periodEnd: summary.sourcePeriod.end,
    persons: summary.persons,
    projects: summary.projects,
    firm: summary.calculationRunId ? summary.firm : null,
    personalBalances
  };
}

export async function listInternalRuleSets(dependencies: { db?: typeof prisma } = {}): Promise<InternalRuleSet[]> {
  const db = dependencies.db ?? prisma;
  const rows = await db.financeRuleSet.findMany({ include: { versions: { orderBy: { version: "desc" } } }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  return rows.map((ruleSet) => ({
    id: ruleSet.id,
    name: ruleSet.name,
    kind: ruleSet.kind,
    versions: ruleSet.versions.map((version) => ({
      id: version.id,
      version: version.version,
      effectiveFrom: version.effectiveFrom.toISOString(),
      effectiveTo: toSerializableDate(version.effectiveTo),
      sourceNote: version.sourceNote,
      publishedAt: toSerializableDate(version.publishedAt),
      definition: (version.definition && typeof version.definition === "object" && !Array.isArray(version.definition) ? version.definition : {}) as InternalRuleSet["versions"][number]["definition"]
    }))
  }));
}

export async function getMonthlyCloseWorkspace(period: string, actor: InternalFinanceActor): Promise<MonthlyCloseWorkspaceData> {
  const db = prisma;
  const status = await getMonthlyCloseStatus(period, { actor: actor as MonthlyCloseActor });
  const [artifacts, adjustments] = await Promise.all([
    status.runId ? db.financeArtifact.findMany({ where: { runId: status.runId }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, fileName: true, byteSize: true, sha256: true } }) : Promise.resolve([]),
    db.financeAdjustment.findMany({ where: { period }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, account: true, targetUserId: true, amount: true, reason: true, status: true, reversalOfId: true, createdAt: true } })
  ]);
  return {
    period,
    status,
    artifacts: artifacts.map((artifact): MonthlyCloseArtifact => ({ ...artifact, kind: String(artifact.kind) })),
    adjustments: adjustments.map((adjustment): MonthlyCloseAdjustment => ({ ...adjustment, amount: fixed(adjustment.amount), status: String(adjustment.status), createdAt: adjustment.createdAt.toISOString() }))
  };
}

export function canReadInternalFinance(actor: InternalFinanceActor): boolean {
  return actor.role === "FINANCE" || (actor.role === "CUSTOM" && actor.rolePermissions?.some((grant) => grant.permissionKey === "finance.read") === true);
}

export async function requireInternalFinanceSession() {
  const session = await requireSession("finance.read");
  if (!canReadInternalFinance(session.user)) redirect("/finance");
  return session;
}
