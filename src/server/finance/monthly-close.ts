import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { storage as storageDefault, type StorageProvider } from "@/lib/storage";
import { auditStrict as auditStrictDefault, auditTx } from "@/server/audit";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { currentAllocationSourceHash } from "@/server/finance/internal-allocation";
import { assessFinancePeriodCoverage, parseFinancePeriodCoverageDetails } from "@/server/finance/internal-source-coverage";
import { buildCloseWorkbook, buildCloseZip, type CloseWorkbookKind } from "@/server/finance/internal-export";
import type { PrismaClient } from "@prisma/client";

export type MonthlyCloseActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type MonthlyCloseDependencies = {
  db?: PrismaClient;
  actor?: MonthlyCloseActor;
  storage?: StorageProvider;
  auditStrict?: typeof auditStrictDefault;
};

export type MonthlyCloseStatus = {
  period: string;
  ready: boolean;
  staleRun: boolean;
  sourceFiles: number;
  sourceKinds: string[];
  coverageConfirmed: boolean;
  transactionCount: number;
  unresolvedCount: number;
  unresolvedIncomeCount: number;
  splitErrorCount: number;
  missingPayrollCount: number;
  templateWarnings: string[];
  blockingWarnings: string[];
  reviewWarnings: string[];
  runId: string | null;
  sourceHash: string | null;
};

function bounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new ActionError("期间必须是 YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    start: new Date(`${period}-01T00:00:00+08:00`),
    end: new Date(`${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00+08:00`)
  };
}

function actorOrSession(actor?: MonthlyCloseActor): Promise<MonthlyCloseActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.read").then((session) => ({ id: session.user.id, role: session.user.role, rolePermissions: session.user.rolePermissions }));
}

function canRead(actor: MonthlyCloseActor): boolean {
  return actor.role === "FINANCE" || (actor.role === "CUSTOM" && Boolean(scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read")));
}

function canAdjust(actor: MonthlyCloseActor): boolean {
  return actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL");
}

function canExport(actor: MonthlyCloseActor): boolean {
  return actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.export") === "ALL");
}

function assertRead(actor: MonthlyCloseActor): void {
  if (!canRead(actor)) throw new ActionError("无权查看月结状态");
}

function assertAdjust(actor: MonthlyCloseActor): void {
  if (!canAdjust(actor)) throw new ActionError("无权维护财务调整");
}

function assertExport(actor: MonthlyCloseActor): void {
  if (!canExport(actor)) throw new ActionError("无权导出财务交付");
}

export async function getMonthlyCloseStatus(period: string, dependencies: MonthlyCloseDependencies = {}): Promise<MonthlyCloseStatus> {
  const actor = await actorOrSession(dependencies.actor);
  assertRead(actor);
  const range = bounds(period);
  const db = dependencies.db ?? prisma;
  const [batches, unresolvedCount, run, close, coverage, typedImportRows] = await Promise.all([
    db.financeImportBatch.findMany({ where: { status: "COMMITTED", periodStart: { lt: range.end }, periodEnd: { gte: range.start } }, select: { id: true, kind: true, rowCount: true } }),
    db.financeReconciliationCase.count({ where: { status: { in: ["UNRESOLVED", "SUGGESTED", "SUSPECT", "EXCEPTION"] }, batch: { periodStart: { lt: range.end }, periodEnd: { gt: range.start } } } }),
    db.financeCalculationRun.findFirst({
      where: { periodStart: range.start, periodEnd: range.end, status: "COMMITTED" },
      orderBy: { calculatedAt: "desc" },
      select: {
        id: true,
        sourceHash: true,
        summary: true,
        allocationLines: { select: { id: true, sourceKind: true, recipients: { select: { id: true } } } },
        personPeriodSnapshots: { select: { id: true, userId: true } },
        firmPeriodSnapshot: { select: { id: true } }
      }
    }),
    db.financeMonthlyClose.findFirst({ where: { period }, orderBy: { revision: "desc" } }),
    db.financePeriodCoverage.findUnique({ where: { period }, select: { details: true } }),
    db.financeImportRecord.findMany({
      where: { period, kind: { in: ["PAYROLL", "ROSTER", "EXTERNAL_THREE_STATEMENTS"] } },
      select: { batchId: true, kind: true, statement: true, reviewStatus: true }
    })
  ]);
  const blockingWarnings: string[] = [];
  const parsedCoverage = parseFinancePeriodCoverageDetails(coverage?.details);
  const coverageAssessment = assessFinancePeriodCoverage(parsedCoverage, batches.map((batch) => ({ id: batch.id, kind: String(batch.kind) })));
  blockingWarnings.push(...coverageAssessment.blockingWarnings);
  const selectedPayrollBatchIds = new Set(parsedCoverage?.payrollBatchIds ?? []);
  const pendingPayrollRows = typedImportRows.filter((row) => String(row.kind) === "PAYROLL" && selectedPayrollBatchIds.has(row.batchId) && String(row.reviewStatus) !== "RESOLVED").length;
  if (pendingPayrollRows > 0) blockingWarnings.push(`工资资料有 ${pendingPayrollRows} 行尚未人工关联或确认`);
  const selectedRosterBatchIds = new Set(parsedCoverage?.rosterBatchIds ?? []);
  const pendingRosterRows = typedImportRows.filter((row) => String(row.kind) === "ROSTER" && selectedRosterBatchIds.has(row.batchId) && String(row.reviewStatus) !== "RESOLVED").length;
  if (pendingRosterRows > 0) blockingWarnings.push(`花名册有 ${pendingRosterRows} 行尚未人工关联`);
  const selectedExternalBatchIds = new Set(parsedCoverage?.externalBatchIds ?? []);
  if (selectedExternalBatchIds.size > 0) {
    const externalRecords = typedImportRows.filter((row) => String(row.kind) === "EXTERNAL_THREE_STATEMENTS" && selectedExternalBatchIds.has(row.batchId));
    const presentStatements = new Set(externalRecords
      .filter((row) => row.statement)
      .map((row) => row.statement!));
    const missingStatements = (["BALANCE_SHEET", "INCOME", "CASH_FLOW"] as const).filter((statement) => !presentStatements.has(statement));
    if (missingStatements.length) {
      const names = missingStatements.map((statement) => statement === "BALANCE_SHEET" ? "资产负债表" : statement === "INCOME" ? "利润表" : "现金流量表");
      coverageAssessment.reviewWarnings.push(`所选外部三表批次缺少${names.join("、")}，本期会计资料包不完整。`);
    }
    const pendingExternalRows = externalRecords.filter((row) => String(row.reviewStatus) !== "RESOLVED").length;
    if (pendingExternalRows > 0) coverageAssessment.reviewWarnings.push(`外部三表有 ${pendingExternalRows} 行尚未人工核对。`);
  }
  let staleRun = false;
  if (unresolvedCount > 0) blockingWarnings.push(`待认领 ${unresolvedCount} 条`);
  if (!run) blockingWarnings.push("没有正式分配批次");
  const sourceKinds = [...new Set(batches.map((batch) => String(batch.kind)))];
  const runSummary = run?.summary && typeof run.summary === "object" && !Array.isArray(run.summary) ? run.summary as Record<string, unknown> : {};
  const allocationLines = run?.allocationLines ?? [];
  const recipientCount = allocationLines.reduce((total, line) => total + line.recipients.length, 0);
  if (run && runSummary.allocationVersion !== 2) blockingWarnings.push("正式批次不是新版分配快照，须重新预览并提交");
  if (run && Array.isArray(runSummary.blockingIssues) && runSummary.blockingIssues.length > 0) {
    blockingWarnings.push(`分配预览仍有 ${runSummary.blockingIssues.length} 项阻断`);
  }
  const lineCount = runSummary.lineCount;
  const storedRecipientCount = runSummary.recipientCount;
  const paymentCount = runSummary.paymentCount;
  const refundCount = runSummary.refundCount;
  if (run && (
    typeof lineCount !== "number" || lineCount !== allocationLines.length ||
    typeof storedRecipientCount !== "number" || storedRecipientCount !== recipientCount ||
    typeof paymentCount !== "number" || typeof refundCount !== "number" || paymentCount + refundCount !== allocationLines.length
  )) blockingWarnings.push("分配明细数量不一致，须重新生成预览");
  const personSnapshotCount = run?.personPeriodSnapshots?.length ?? 0;
  if (run && (
    runSummary.snapshotVersion !== "personal-v1" ||
    typeof runSummary.personSnapshotCount !== "number" || runSummary.personSnapshotCount !== personSnapshotCount ||
    runSummary.firmSnapshotCount !== 1 || !run.firmPeriodSnapshot
  )) blockingWarnings.push("个人或律所经营快照缺失/数量不符，须重新生成分配批次");
  const summaryMissingPayrollCount = runSummary.missingPayrollCount;
  if (run) {
    if (typeof summaryMissingPayrollCount !== "number") blockingWarnings.push("正式批次未记录工资缺口统计，不能确认工资来源完整性");
    else if (summaryMissingPayrollCount > 0) blockingWarnings.push(`仍缺 ${summaryMissingPayrollCount} 人工资事实或复核`);
  }
  const summarySplitErrorCount = runSummary.splitErrorCount;
  if (run) {
    if (typeof summarySplitErrorCount !== "number") blockingWarnings.push("正式批次未记录分配异常统计");
    else if (summarySplitErrorCount > 0) blockingWarnings.push(`仍有 ${summarySplitErrorCount} 项分配异常`);
  }
  if (run) {
    try {
      const currentHash = await currentAllocationSourceHash({ periodStart: shDayKey(range.start), periodEnd: shDayKey(range.end) }, { db });
      if (currentHash !== run.sourceHash) {
        staleRun = true;
        blockingWarnings.push("本期来源已变化，正式批次已过期，请重新预览并提交");
      }
    } catch {
      staleRun = true;
      blockingWarnings.push("无法核验本期来源指纹，暂不能月结");
    }
  }
  const transactionCount = batches.reduce((total, batch) => total + batch.rowCount, 0);
  const splitErrorCount = typeof runSummary.splitErrorCount === "number" ? runSummary.splitErrorCount : 0;
  const missingPayrollCount = typeof runSummary.missingPayrollCount === "number" ? runSummary.missingPayrollCount : 0;
  return {
    period,
    ready: blockingWarnings.length === 0,
    staleRun,
    sourceFiles: batches.length,
    sourceKinds,
    transactionCount,
    unresolvedCount,
    unresolvedIncomeCount: unresolvedCount,
    splitErrorCount,
    missingPayrollCount,
    templateWarnings: Array.isArray(close?.templateWarnings) ? close.templateWarnings as string[] : [],
    blockingWarnings,
    reviewWarnings: [...coverageAssessment.reviewWarnings, ...(Array.isArray(close?.reviewWarnings) ? close.reviewWarnings as string[] : [])],
    coverageConfirmed: parsedCoverage !== null,
    runId: run?.id ?? null,
    sourceHash: run?.sourceHash ?? null
  };
}

const adjustmentSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  account: z.string().trim().min(1).max(120),
  targetUserId: z.string().trim().min(1).nullish(),
  amount: z.string().trim().regex(/^-?\d+(?:\.\d{1,2})?$/),
  reason: z.string().trim().min(1).max(1000),
  evidenceRef: z.string().trim().max(200).nullish()
});

export async function createFinanceAdjustment(input: unknown, dependencies: MonthlyCloseDependencies = {}): Promise<{ id: string; runId: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertAdjust(actor);
  const parsed = adjustmentSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("财务调整信息不完整");
  const data = parsed.data;
  const range = bounds(data.period);
  const db = dependencies.db ?? prisma;
  const run = await db.financeCalculationRun.findFirst({ where: { periodStart: range.start, periodEnd: range.end, status: "COMMITTED" }, orderBy: { calculatedAt: "desc" }, select: { id: true } });
  if (!run) throw new ActionError("请先生成正式计算批次，再登记调整");
  return db.$transaction(async (tx) => {
    const created = await tx.financeAdjustment.create({
      data: { period: data.period, account: data.account, targetUserId: data.targetUserId ?? null, amount: new Prisma.Decimal(data.amount), reason: data.reason, evidenceRef: data.evidenceRef ?? null, status: "POSTED", createdById: actor.id },
      select: { id: true }
    });
    await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_ADJUSTMENT_CREATE", targetType: "FinanceAdjustment", targetId: created.id, detail: { period: data.period, account: data.account, amount: data.amount, runId: run.id } });
    return { id: created.id, runId: run.id };
  });
}

export async function reverseFinanceAdjustment(id: string, note: string, dependencies: MonthlyCloseDependencies = {}): Promise<{ reversalId: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertAdjust(actor);
  if (!note.trim()) throw new ActionError("冲销必须填写原因");
  const db = dependencies.db ?? prisma;
  const original = await db.financeAdjustment.findUnique({ where: { id } });
  if (!original) throw new ActionError("调整凭证不存在");
  if (original.status === "REVERSED" || original.reversalOfId) throw new ActionError("该调整已经冲销");
  return db.$transaction(async (tx) => {
    const reversal = await tx.financeAdjustment.create({
      data: { period: original.period, account: original.account, targetUserId: original.targetUserId, amount: new Prisma.Decimal(original.amount).negated(), reason: note.trim(), evidenceRef: original.evidenceRef, reversalOfId: original.id, status: "POSTED", createdById: actor.id },
      select: { id: true }
    });
    await tx.financeAdjustment.update({ where: { id: original.id }, data: { status: "REVERSED" } });
    await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_ADJUSTMENT_REVERSE", targetType: "FinanceAdjustment", targetId: reversal.id, detail: { reversalOfId: original.id, period: original.period } });
    return { reversalId: reversal.id };
  });
}

export async function generateMonthlyClose(period: string, dependencies: MonthlyCloseDependencies = {}) {
  const actor = await actorOrSession(dependencies.actor);
  assertExport(actor);
  assertRead(actor);
  const status = await getMonthlyCloseStatus(period, dependencies);
  if (!status.ready || !status.runId) throw new ActionError(`存在阻断项：${status.blockingWarnings.join("；")}`);
  const runId = status.runId;
  const db = dependencies.db ?? prisma;
  const storage = dependencies.storage ?? storageDefault;
  const existingArtifacts = await db.financeArtifact.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
  if (existingArtifacts.length === 5) return existingArtifacts;
  if (existingArtifacts.length > 0) throw new ActionError("该计算批次已有不完整的月结交付记录，请先核对存储后再重试");
  const workbookKinds: CloseWorkbookKind[] = ["WAGE", "ACCOUNTANT", "PERSONAL", "ADJUSTMENT_AUDIT"];
  const workbookEntries = await Promise.all(workbookKinds.map(async (kind) => [kind, await buildCloseWorkbook(kind, runId, { db, actor })] as const));
  const workbooks = Object.fromEntries(workbookEntries) as Record<CloseWorkbookKind, Buffer>;
  const zipBytes = buildCloseZip(period, runId, workbooks, status.sourceHash ?? "");
  const artifacts = [
    { kind: "WAGE" as const, fileName: `工资-${period}.xlsx`, bytes: workbooks.WAGE },
    { kind: "ACCOUNTANT" as const, fileName: `会计资料-${period}.xlsx`, bytes: workbooks.ACCOUNTANT },
    { kind: "PERSONAL" as const, fileName: `个人内账-${period}.xlsx`, bytes: workbooks.PERSONAL },
    { kind: "ADJUSTMENT_AUDIT" as const, fileName: `调整审计-${period}.xlsx`, bytes: workbooks.ADJUSTMENT_AUDIT },
    { kind: "ZIP" as const, fileName: `LawLink-月结-${period}.zip`, bytes: zipBytes }
  ];
  const stored: Array<{ kind: typeof artifacts[number]["kind"]; fileName: string; bytes: Buffer; path: string }> = [];
  try {
    for (const artifact of artifacts) stored.push({ ...artifact, path: await storage.writeFile("finance-artifacts", artifact.bytes) });
    const created = await db.$transaction(async (tx) => {
      const previousClose = await tx.financeMonthlyClose.findFirst({ where: { period }, orderBy: { revision: "desc" }, select: { revision: true } });
      const close = await tx.financeMonthlyClose.create({
        data: { period, revision: (previousClose?.revision ?? 0) + 1, runId, sourceHash: status.sourceHash, status: "CLOSED", transactionCount: status.transactionCount, unresolvedCount: 0, unresolvedIncomeCount: 0, splitErrorCount: status.splitErrorCount, missingPayrollCount: status.missingPayrollCount, templateWarnings: status.templateWarnings, blockingWarnings: [], reviewWarnings: status.reviewWarnings, createdById: actor.id }
      });
      const rows = [];
      for (const artifact of stored) {
        rows.push(await tx.financeArtifact.create({ data: { runId, monthlyCloseId: close.id, kind: artifact.kind, fileName: artifact.fileName, storagePath: artifact.path, sha256: createHash("sha256").update(artifact.bytes).digest("hex"), byteSize: artifact.bytes.byteLength } }));
      }
      await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_MONTHLY_CLOSE_GENERATE", targetType: "FinanceMonthlyClose", targetId: close.id, detail: { period, runId, artifactCount: rows.length } });
      return rows;
    });
    return created;
  } catch (caught) {
    await Promise.all(stored.map(async (artifact) => { try { await storage.deleteFile(artifact.path); } catch (cleanupError) { console.error("[finance-close] 清理交付文件失败", cleanupError); } }));
    throw caught;
  }
}

export class FinanceArtifactNotFoundError extends Error {
  constructor() { super("财务交付文件不存在"); this.name = "FinanceArtifactNotFoundError"; }
}

export async function downloadFinanceArtifact(id: string, dependencies: MonthlyCloseDependencies = {}): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertRead(actor);
  assertExport(actor);
  const db = dependencies.db ?? prisma;
  const artifact = await db.financeArtifact.findUnique({ where: { id }, include: { run: true } });
  if (!artifact || artifact.run.status !== "COMMITTED") throw new FinanceArtifactNotFoundError();
  const storage = dependencies.storage ?? storageDefault;
  const bytes = await storage.readFile(artifact.storagePath);
  await (dependencies.auditStrict ?? auditStrictDefault)({ userId: actor.id, action: "FINANCE_INTERNAL_ARTIFACT_DOWNLOAD", targetType: "FinanceArtifact", targetId: artifact.id, detail: { kind: artifact.kind, byteCount: bytes.byteLength } });
  return { bytes, fileName: artifact.fileName, mimeType: artifact.kind === "ZIP" ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
