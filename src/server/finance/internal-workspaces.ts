import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { shDayKey, shParts } from "@/lib/ui/sh-time";
import { getInternalFinanceSummary } from "@/server/finance/internal-reports";
import { listFinanceReconciliationCases } from "@/server/finance/internal-reconciliation";
import { getMonthlyCloseStatus, type MonthlyCloseActor } from "@/server/finance/monthly-close";
import { parseFinancePeriodCoverageDetails } from "@/server/finance/internal-source-coverage";
import { requireSession } from "@/lib/auth/session";
import type { FinanceReportsActor } from "@/server/finance/internal-reports";
import type { FinanceReconciliationActor } from "@/server/finance/internal-reconciliation";
import type {
  InternalImportBatch,
  InternalLedgerView,
  InternalRuleSet,
  MonthlyCloseAdjustment,
  MonthlyCloseArtifact,
  MonthlyCloseWorkspaceData,
  ReconciliationWorkspaceQueue
} from "@/app/(app)/finance/internal/_components/types";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";

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

export async function listInternalImportBatches(dependencies: { db?: typeof prisma; actor?: InternalFinanceActor } = {}): Promise<InternalImportBatch[]> {
  const actor = dependencies.actor ?? (await requireSession("finance.read")).user;
  const grants = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
  const scope = actor.role === "FINANCE" ? "ALL"
    : actor.role === "CUSTOM" && (scopeFor(grants, "finance.read") === "ALL" || scopeFor(grants, "finance.import") === "ALL") ? "ALL"
      : actor.role === "CUSTOM" && scopeFor(grants, "finance.read") === "OWN" ? "OWN"
        : null;
  if (!scope) return [];
  const db = dependencies.db ?? prisma;
  const rows = await db.financeImportBatch.findMany({
    where: scope === "OWN" ? { createdById: actor.id } : undefined,
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
  const summary = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, { actor: actor as FinanceReportsActor });
  const snapshots = summary.calculationRunId ? await prisma.financePersonPeriodSnapshot.findMany({
    where: { runId: summary.calculationRunId },
    include: { user: { select: { name: true } } },
    orderBy: { userId: "asc" }
  }) : [];
  const personalBalances = snapshots.map((snapshot) => ({
    userId: snapshot.userId,
    userName: snapshot.user.name,
    distributableEnd: fixed(snapshot.distributableEnd),
    selfFundingReserveEnd: fixed(snapshot.reserveEnd),
    reserveGap: fixed(snapshot.reserveGap)
  }));
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
  const { start, end } = financePeriodBounds(period);
  const [artifacts, adjustments, sourceBatches, coverage] = await Promise.all([
    status.runId ? db.financeArtifact.findMany({ where: { runId: status.runId }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, fileName: true, byteSize: true, sha256: true } }) : Promise.resolve([]),
    db.financeAdjustment.findMany({ where: { period }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, account: true, targetUserId: true, amount: true, reason: true, status: true, reversalOfId: true, createdAt: true } }),
    db.financeImportBatch.findMany({ where: { status: "COMMITTED", periodStart: { lt: end }, periodEnd: { gte: start } }, orderBy: [{ kind: "asc" }, { fileName: "asc" }], select: { id: true, kind: true, fileName: true, rowCount: true } }),
    db.financePeriodCoverage.findUnique({ where: { period }, select: { details: true } })
  ]);
  return {
    period,
    status,
    sourceBatches: sourceBatches.map((batch) => ({ ...batch, kind: String(batch.kind) })),
    coverageDetails: parseFinancePeriodCoverageDetails(coverage?.details),
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
