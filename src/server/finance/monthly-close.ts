import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import PizZip from "pizzip";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { storage as storageDefault, type StorageProvider } from "@/lib/storage";
import { auditStrict as auditStrictDefault, auditTx } from "@/server/audit";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { buildFinanceWorkbook } from "@/server/finance/internal-export";
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
  sourceFiles: number;
  sourceKinds: string[];
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

function assertRead(actor: MonthlyCloseActor): void {
  if (!canRead(actor)) throw new ActionError("无权查看月结状态");
}

function assertAdjust(actor: MonthlyCloseActor): void {
  if (!canAdjust(actor)) throw new ActionError("无权维护财务调整");
}

export async function getMonthlyCloseStatus(period: string, dependencies: MonthlyCloseDependencies = {}): Promise<MonthlyCloseStatus> {
  const actor = await actorOrSession(dependencies.actor);
  assertRead(actor);
  const range = bounds(period);
  const db = dependencies.db ?? prisma;
  const [batches, unresolvedCount, run, close] = await Promise.all([
    db.financeImportBatch.findMany({ where: { status: "COMMITTED", periodStart: { lt: range.end }, periodEnd: { gt: range.start } }, select: { kind: true, rowCount: true } }),
    db.financeReconciliationCase.count({ where: { status: { in: ["UNRESOLVED", "SUGGESTED", "SUSPECT", "EXCEPTION"] }, batch: { periodStart: { lt: range.end }, periodEnd: { gt: range.start } } } }),
    db.financeCalculationRun.findFirst({ where: { periodStart: range.start, periodEnd: range.end, status: "COMMITTED" }, orderBy: { calculatedAt: "desc" }, select: { id: true, sourceHash: true, summary: true } }),
    db.financeMonthlyClose.findUnique({ where: { period } })
  ]);
  const blockingWarnings: string[] = [];
  if (unresolvedCount > 0) blockingWarnings.push(`待认领 ${unresolvedCount} 条`);
  if (!run) blockingWarnings.push("没有正式分配批次");
  const sourceKinds = [...new Set(batches.map((batch) => String(batch.kind)))];
  const runSummary = run?.summary && typeof run.summary === "object" && !Array.isArray(run.summary) ? run.summary as Record<string, unknown> : {};
  const transactionCount = batches.reduce((total, batch) => total + batch.rowCount, 0);
  const splitErrorCount = typeof runSummary.splitErrorCount === "number" ? runSummary.splitErrorCount : 0;
  const missingPayrollCount = typeof runSummary.missingPayrollCount === "number" ? runSummary.missingPayrollCount : 0;
  return {
    period,
    ready: blockingWarnings.length === 0,
    sourceFiles: batches.length,
    sourceKinds,
    transactionCount,
    unresolvedCount,
    unresolvedIncomeCount: unresolvedCount,
    splitErrorCount,
    missingPayrollCount,
    templateWarnings: Array.isArray(close?.templateWarnings) ? close.templateWarnings as string[] : [],
    blockingWarnings,
    reviewWarnings: Array.isArray(close?.reviewWarnings) ? close.reviewWarnings as string[] : [],
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
  assertRead(actor);
  const status = await getMonthlyCloseStatus(period, dependencies);
  if (!status.ready || !status.runId) throw new ActionError(`存在阻断项：${status.blockingWarnings.join("；")}`);
  const runId = status.runId;
  const range = bounds(period);
  const db = dependencies.db ?? prisma;
  const storage = dependencies.storage ?? storageDefault;
  const existingArtifacts = await db.financeArtifact.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
  if (existingArtifacts.length === 5) return existingArtifacts;
  if (existingArtifacts.length > 0) throw new ActionError("该计算批次已有不完整的月结交付记录，请先核对存储后再重试");
  const workbook = await buildFinanceWorkbook({ start: range.start, end: range.end, groupBy: "ALL" }, { db, actor });
  const zip = new PizZip();
  zip.file("README.txt", `LawLink 内部财务月结包\n期间：${period}\n计算批次：${status.runId}\n`);
  zip.file("经营财务工作簿.xlsx", workbook);
  const zipBytes = zip.generate({ type: "nodebuffer" }) as Buffer;
  const artifacts = [
    { kind: "WAGE" as const, fileName: `工资-${period}.xlsx`, bytes: workbook },
    { kind: "ACCOUNTANT" as const, fileName: `会计资料-${period}.xlsx`, bytes: workbook },
    { kind: "PERSONAL" as const, fileName: `个人内账-${period}.xlsx`, bytes: workbook },
    { kind: "ADJUSTMENT_AUDIT" as const, fileName: `调整审计-${period}.xlsx`, bytes: workbook },
    { kind: "ZIP" as const, fileName: `LawLink-月结-${period}.zip`, bytes: zipBytes }
  ];
  const stored: Array<{ kind: typeof artifacts[number]["kind"]; fileName: string; bytes: Buffer; path: string }> = [];
  try {
    for (const artifact of artifacts) stored.push({ ...artifact, path: await storage.writeFile("finance-artifacts", artifact.bytes) });
    const created = await db.$transaction(async (tx) => {
      const close = await tx.financeMonthlyClose.upsert({
        where: { period },
        create: { period, runId, sourceHash: status.sourceHash, status: "CLOSED", transactionCount: status.transactionCount, unresolvedCount: 0, unresolvedIncomeCount: 0, splitErrorCount: status.splitErrorCount, missingPayrollCount: status.missingPayrollCount, templateWarnings: status.templateWarnings, blockingWarnings: [], reviewWarnings: status.reviewWarnings, createdById: actor.id },
        update: { runId, sourceHash: status.sourceHash, status: "CLOSED", transactionCount: status.transactionCount, unresolvedCount: 0, unresolvedIncomeCount: 0, splitErrorCount: status.splitErrorCount, missingPayrollCount: status.missingPayrollCount, templateWarnings: status.templateWarnings, blockingWarnings: [], reviewWarnings: status.reviewWarnings }
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
  const db = dependencies.db ?? prisma;
  const artifact = await db.financeArtifact.findUnique({ where: { id }, include: { run: true } });
  if (!artifact || artifact.run.status !== "COMMITTED") throw new FinanceArtifactNotFoundError();
  const storage = dependencies.storage ?? storageDefault;
  const bytes = await storage.readFile(artifact.storagePath);
  await (dependencies.auditStrict ?? auditStrictDefault)({ userId: actor.id, action: "FINANCE_INTERNAL_ARTIFACT_DOWNLOAD", targetType: "FinanceArtifact", targetId: artifact.id, detail: { kind: artifact.kind, byteCount: bytes.byteLength } });
  return { bytes, fileName: artifact.fileName, mimeType: artifact.kind === "ZIP" ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
