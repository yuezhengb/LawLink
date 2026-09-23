import { z } from "zod";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { auditTx } from "@/server/audit";
import type { PrismaClient } from "@prisma/client";

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const reasonSchema = z.string().trim().min(5).max(500);
const coverageDetailsSchema = z.object({
  bankAccounts: z.array(z.object({
    alias: z.string().trim().min(1).max(60),
    batchIds: z.array(z.string().trim().min(1).max(100)).max(200),
    noTransactionsReason: reasonSchema.optional()
  }).strict()).min(1).max(30),
  payrollBatchIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  noPayrollReason: reasonSchema.optional(),
  rosterBatchIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  noRosterReason: reasonSchema.optional(),
  externalBatchIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  noExternalReason: reasonSchema.optional()
}).strict();

export type FinancePeriodCoverageDetails = z.infer<typeof coverageDetailsSchema>;
export type CoverageBatch = { id: string; kind: string };

export function parseFinancePeriodCoverageDetails(value: unknown): FinancePeriodCoverageDetails | null {
  const parsed = coverageDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function assessFinancePeriodCoverage(
  details: unknown,
  batches: CoverageBatch[]
): { blockingWarnings: string[]; reviewWarnings: string[] } {
  const coverage = parseFinancePeriodCoverageDetails(details);
  if (!coverage) return { blockingWarnings: ["尚未确认本期银行、工资与花名册来源覆盖"], reviewWarnings: [] };
  const blockingWarnings: string[] = [];
  const reviewWarnings: string[] = [];
  const known = new Map(batches.map((batch) => [batch.id, batch.kind]));
  const coveredBank = coverage.bankAccounts.flatMap((account) => account.batchIds);
  const duplicates = coveredBank.filter((id, index) => coveredBank.indexOf(id) !== index);
  if (duplicates.length) blockingWarnings.push("同一银行流水批次被重复归入多个账户别名");
  const currentBankIds = batches.filter((batch) => batch.kind === "BANK_STATEMENT").map((batch) => batch.id);
  const missingBankIds = currentBankIds.filter((id) => !coveredBank.includes(id));
  if (missingBankIds.length) blockingWarnings.push(`有 ${missingBankIds.length} 份银行流水未纳入账户覆盖`);
  const aliases = coverage.bankAccounts.map((account) => account.alias.trim().toLocaleLowerCase());
  if (aliases.some((alias, index) => aliases.indexOf(alias) !== index)) blockingWarnings.push("银行账户别名重复，请合并为一个账户覆盖项");
  for (const account of coverage.bankAccounts) {
    if (!account.batchIds.length && !account.noTransactionsReason) blockingWarnings.push(`账户“${account.alias}”没有流水批次，也没有零流水说明`);
    for (const id of account.batchIds) if (known.get(id) !== "BANK_STATEMENT") blockingWarnings.push(`账户“${account.alias}”关联了无效或非银行来源批次`);
  }
  if (!coverage.payrollBatchIds.length && !coverage.noPayrollReason) blockingWarnings.push("工资表未覆盖，也未确认本期无工资资料");
  if (coverage.payrollBatchIds.some((id) => known.get(id) !== "PAYROLL")) blockingWarnings.push("工资覆盖关联了无效或非工资批次");
  if (!coverage.rosterBatchIds.length && !coverage.noRosterReason) blockingWarnings.push("花名册未覆盖，也未确认本期无需更新");
  if (coverage.rosterBatchIds.some((id) => known.get(id) !== "ROSTER")) blockingWarnings.push("花名册覆盖关联了无效或非花名册批次");
  if (!coverage.externalBatchIds.length && !coverage.noExternalReason) blockingWarnings.push("外部三表未覆盖，也未说明尚未取得的原因");
  if (coverage.externalBatchIds.some((id) => known.get(id) !== "EXTERNAL_THREE_STATEMENTS")) blockingWarnings.push("外部三表覆盖关联了无效批次");
  if (!coverage.externalBatchIds.length && coverage.noExternalReason) reviewWarnings.push(`外部三表尚未归档：${coverage.noExternalReason}`);
  return { blockingWarnings: [...new Set(blockingWarnings)], reviewWarnings };
}

export type FinanceCoverageActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type FinanceCoverageDependencies = { db?: PrismaClient; actor?: FinanceCoverageActor };

function monthBounds(period: string) {
  const [year, month] = period.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: new Date(`${period}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`)
  };
}

function assertFinanceAdjust(actor: FinanceCoverageActor) {
  const allowed = actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL");
  if (!allowed) throw new ActionError("无权确认财务来源覆盖");
}

export async function saveFinancePeriodCoverage(input: unknown, dependencies: FinanceCoverageDependencies = {}) {
  const actor = dependencies.actor;
  if (!actor) throw new ActionError("请先登录财务账号");
  assertFinanceAdjust(actor);
  const schema = z.object({ period: periodSchema, details: coverageDetailsSchema }).strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ActionError("来源覆盖信息不完整或格式不正确");
  const { period, details } = parsed.data;
  const range = monthBounds(period);
  const db = dependencies.db ?? prisma;
  const batches = await db.financeImportBatch.findMany({
    where: { status: "COMMITTED", periodStart: { lt: range.end }, periodEnd: { gte: range.start } },
    select: { id: true, kind: true }
  });
  const assessment = assessFinancePeriodCoverage(details, batches.map((batch) => ({ id: batch.id, kind: String(batch.kind) })));
  if (assessment.blockingWarnings.length) throw new ActionError(`来源覆盖未通过：${assessment.blockingWarnings.join("；")}`);

  const selectedIds = [
    ...details.bankAccounts.flatMap((account) => account.batchIds),
    ...details.payrollBatchIds,
    ...details.rosterBatchIds,
    ...details.externalBatchIds
  ];
  if (selectedIds.length !== new Set(selectedIds).size) throw new ActionError("同一来源批次不能重复归类");
  const saved = await db.$transaction(async (tx) => {
    const coverage = await tx.financePeriodCoverage.upsert({
      where: { period },
      create: { period, details, confirmedById: actor.id },
      update: { details, confirmedById: actor.id, confirmedAt: new Date() },
      select: { id: true, period: true, confirmedAt: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_SOURCE_COVERAGE_CONFIRM",
      targetType: "FinancePeriodCoverage",
      targetId: coverage.id,
      detail: { period, bankAccountCount: details.bankAccounts.length, batchCount: selectedIds.length }
    });
    return coverage;
  });
  return { id: saved.id, period: saved.period, confirmedAt: saved.confirmedAt.toISOString() };
}
