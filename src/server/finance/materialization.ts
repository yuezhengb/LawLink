import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import type { PrismaClient } from "@prisma/client";

export type FinanceMaterializationActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type FinanceMaterializationDependencies = { db?: PrismaClient; actor?: FinanceMaterializationActor };

function periodBounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new ActionError("期间必须是 YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return { start: new Date(`${period}-01T00:00:00+08:00`), end: new Date(`${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00+08:00`) };
}

function actorOrSession(actor?: FinanceMaterializationActor): Promise<FinanceMaterializationActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.rules").then((session) => ({ id: session.user.id, role: session.user.role, rolePermissions: session.user.rolePermissions }));
}

function assertAccess(actor: FinanceMaterializationActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.rules") === "ALL") return;
  throw new ActionError("无权生成正式财务计算批次");
}

function redacted(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toFixed(2);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redacted);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = redacted((value as Record<string, unknown>)[key]);
      return result;
    }, {});
  }
  return value;
}

export async function sourceFingerprintForPeriod(
  period: string,
  dependencies: FinanceMaterializationDependencies = {}
): Promise<string> {
  const { start, end } = periodBounds(period);
  const db = dependencies.db ?? prisma;
  const [sourceRows, payments, refundLinks, matterProfiles, commissionPlans, ruleVersions, users, payrollFacts, taxRecords, capitalFlows, adjustments] = await Promise.all([
    db.financeSourceRow.findMany({ where: { occurredAt: { gte: start, lt: end } }, orderBy: [{ batchId: "asc" }, { sourceRow: "asc" }] }),
    db.payment.findMany({ where: { occurredAt: { gte: start, lt: end }, moneyKind: "LAWYER_FEE", sourceEntry: { confirmState: "CONFIRMED" } }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
    db.financeRefundLink.findMany({ where: { active: true }, orderBy: [{ paymentId: "asc" }, { sourceRowId: "asc" }] }),
    db.financeMatterProfile.findMany({ orderBy: { matterId: "asc" } }),
    db.commissionPlan.findMany({ where: { active: true }, orderBy: [{ matterId: "asc" }, { userId: "asc" }] }),
    db.financeRuleVersion.findMany({ where: { publishedAt: { not: null }, effectiveFrom: { lt: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }] }, orderBy: [{ ruleSetId: "asc" }, { version: "asc" }] }),
    db.user.findMany({ where: { active: true }, select: { id: true, active: true, role: true, managerAuthorized: true }, orderBy: { id: "asc" } }),
    db.financePayrollFact.findMany({ where: { period }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financePartnerTaxRecord.findMany({ where: { period }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financeCapitalFlow.findMany({ where: { period }, orderBy: [{ investorId: "asc" }, { id: "asc" }] }),
    db.financeAdjustment.findMany({ where: { period }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  ]);
  const payload = redacted({ period, sourceRows, payments, refundLinks, matterProfiles, commissionPlans, ruleVersions, users, payrollFacts, taxRecords, capitalFlows, adjustments });
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export async function materializeFinancePeriod(
  input: { period: string },
  dependencies: FinanceMaterializationDependencies = {}
) {
  const actor = await actorOrSession(dependencies.actor);
  assertAccess(actor);
  const bounds = periodBounds(input.period);
  const db = dependencies.db ?? prisma;
  const sourceHash = await sourceFingerprintForPeriod(input.period, dependencies);
  const existing = await db.financeCalculationRun.findFirst({
    where: { periodStart: bounds.start, periodEnd: bounds.end, sourceHash, status: "COMMITTED" },
    orderBy: { calculatedAt: "desc" }
  });
  if (existing) return existing;

  try {
    return await db.$transaction(async (tx) => {
      const previous = await tx.financeCalculationRun.findFirst({
        where: { periodStart: bounds.start, periodEnd: bounds.end, status: "COMMITTED", sourceHash: { not: sourceHash } },
        orderBy: { calculatedAt: "desc" },
        select: { id: true }
      });
      const run = await tx.financeCalculationRun.create({
        data: {
          periodStart: bounds.start,
          periodEnd: bounds.end,
          sourceHash,
          ruleVersionIds: [],
          status: "COMMITTED",
          trigger: "MONTHLY_CLOSE",
          summary: { materialized: true, sourceHash },
          createdById: actor.id
        }
      });
      if (previous) await tx.financeCalculationRun.update({ where: { id: previous.id }, data: { status: "SUPERSEDED", supersededById: run.id } });
      await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_MATERIALIZE", targetType: "FinanceCalculationRun", targetId: run.id, detail: { period: input.period, sourceHash } });
      return run;
    });
  } catch (caught) {
    if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002") {
      const concurrent = await db.financeCalculationRun.findFirst({
        where: { periodStart: bounds.start, periodEnd: bounds.end, sourceHash, status: "COMMITTED" },
        orderBy: { calculatedAt: "desc" }
      });
      if (concurrent) return concurrent;
    }
    throw caught;
  }
}
