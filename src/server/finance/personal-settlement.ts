import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import type { PrismaClient } from "@prisma/client";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { auditStrict as auditStrictDefault } from "@/server/audit";

export type FinanceSettlementActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type FinanceSettlementDependencies = {
  db?: Pick<PrismaClient, "financeCalculationRun" | "financePersonPeriodSnapshot" | "financeAllocationLine">;
  auditStrict?: typeof auditStrictDefault;
};
export type AvailableSettlementRun = { id: string; period: string; sourceHash: string; calculatedAt: string };

type Run = { id: string; status: string; periodStart: Date; periodEnd: Date; sourceHash: string };
type Snapshot = {
  userId: string;
  period: string;
  user: { name: string };
  openingDistributable: unknown;
  openingReserve: unknown;
  earned: unknown;
  selfCostDue: unknown;
  selfFundingIn: unknown;
  selfFundingUsed: unknown;
  selfCostChargedToIncome: unknown;
  withdrawn: unknown;
  partnerTaxAdvance: unknown;
  unsettledHold: unknown;
  distributableEnd: unknown;
  reserveEnd: unknown;
  reserveGap: unknown;
};
type AllocationLine = {
  id: string;
  targetUserId: string | null;
  sourceKind: string;
  refundLinkId: string | null;
  sourceOccurredAt: Date | null;
  grossAmount: unknown;
  channelAmount: unknown;
  firmAmount: unknown;
  sourceAmount: unknown;
  handlingAmount: unknown;
  coAmount: unknown;
  matter: { internalCode: string; title: string };
  payment: { id: string };
  recipients: Array<{ userId: string; role: string; amount: unknown }>;
};

function canExportActor(actor: FinanceSettlementActor): "ALL" | "OWN" | null {
  if (actor.role === "FINANCE") return "ALL";
  if (actor.role !== "CUSTOM") return null;
  const grants = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
  if (scopeFor(grants, "finance.export") === "ALL") return "ALL";
  if (scopeFor(grants, "finance.read") === "OWN") return "OWN";
  return null;
}

function fixed(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

function masked(value: string): string {
  return `****${value.slice(-6)}`;
}

function addMeta(sheet: ExcelJS.Worksheet, run: Run, period: string): void {
  sheet.addRow(["正式批次", run.id, "来源指纹", run.sourceHash, "期间", period]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 2 }];
}

function addPersonalSnapshot(workbook: ExcelJS.Workbook, snapshot: Snapshot, run: Run, period: string): void {
  const sheet = workbook.addWorksheet("个人余额快照");
  addMeta(sheet, run, period);
  sheet.addRow(["人员", "期初可分配", "期初预存", "本期所得", "自担成本", "本期预存", "预存承担成本", "收入承担成本", "实际提款", "合伙人税款预付", "待结算留存", "期末可分配", "期末预存", "预存缺口"]);
  sheet.addRow([
    snapshot.user.name, ...[
      snapshot.openingDistributable, snapshot.openingReserve, snapshot.earned, snapshot.selfCostDue,
      snapshot.selfFundingIn, snapshot.selfFundingUsed, snapshot.selfCostChargedToIncome, snapshot.withdrawn,
      snapshot.partnerTaxAdvance, snapshot.unsettledHold, snapshot.distributableEnd, snapshot.reserveEnd, snapshot.reserveGap
    ].map((value) => Number(fixed(value)))
  ]);
  for (let column = 2; column <= 14; column += 1) sheet.getCell(3, column).numFmt = "#,##0.00";
}

function personalRoleAmounts(line: AllocationLine, userId: string) {
  const recipients = line.recipients.filter((recipient) => recipient.userId === userId);
  if (recipients.length) {
    const amountByRole = { SOURCE: 0, HANDLING: 0, CO: 0 };
    for (const recipient of recipients) {
      if (recipient.role === "SOURCE" || recipient.role === "HANDLING" || recipient.role === "CO") {
        amountByRole[recipient.role] += Number(fixed(recipient.amount));
      }
    }
    return amountByRole;
  }
  if (line.targetUserId !== userId) return { SOURCE: 0, HANDLING: 0, CO: 0 };
  return { SOURCE: Number(fixed(line.sourceAmount)), HANDLING: Number(fixed(line.handlingAmount)), CO: Number(fixed(line.coAmount)) };
}

function addPersonalAllocations(workbook: ExcelJS.Workbook, lines: AllocationLine[], userId: string, run: Run, period: string): void {
  const sheet = workbook.addWorksheet("本人分配明细");
  addMeta(sheet, run, period);
  sheet.addRow(["所内案号", "案件", "来源类型", "发生日期", "付款引用", "退款关联", "本人分配", "案源", "承办", "协办"]);
  for (const line of lines) {
    const amounts = personalRoleAmounts(line, userId);
    const personal = amounts.SOURCE + amounts.HANDLING + amounts.CO;
    sheet.addRow([
      line.matter.internalCode,
      line.matter.title,
      line.sourceKind === "REFUND" ? "退款冲回" : "律师费收款",
      line.sourceOccurredAt ? shDayKey(line.sourceOccurredAt) : "",
      masked(line.payment.id),
      line.refundLinkId ? masked(line.refundLinkId) : "",
      personal, amounts.SOURCE, amounts.HANDLING, amounts.CO
    ]);
  }
  for (let column = 7; column <= 10; column += 1) for (let row = 3; row <= sheet.rowCount; row += 1) sheet.getCell(row, column).numFmt = "#,##0.00";
}

function styleWorkbook(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    sheet.columns.forEach((column) => {
      column.width = Math.max(12, Math.min(32, String(column.header ?? "").length + 4));
    });
  }
}

async function committedRun(runId: string, db: FinanceSettlementDependencies["db"]): Promise<Run> {
  const run = await db!.financeCalculationRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, periodStart: true, periodEnd: true, sourceHash: true }
  });
  if (!run || run.status !== "COMMITTED") throw new ActionError("正式财务批次不存在或未提交");
  return run as Run;
}

function assertExport(actor: FinanceSettlementActor, userId: string): "ALL" | "OWN" {
  const scope = canExportActor(actor);
  if (!scope) throw new ActionError("无财务导出权限");
  if (scope === "OWN" && userId !== actor.id) throw new ActionError("无权导出其他人员结算");
  return scope;
}

async function buildWorkbookForUser(run: Run, userId: string, actor: FinanceSettlementActor, db: NonNullable<FinanceSettlementDependencies["db"]>): Promise<{ bytes: Buffer; snapshot: Snapshot; period: string; rowCount: number }> {
  const snapshot = await db.financePersonPeriodSnapshot.findUnique({
    where: { runId_userId: { runId: run.id, userId } },
    include: { user: { select: { name: true } } }
  }) as Snapshot | null;
  if (!snapshot) throw new ActionError("该正式批次没有此人员的结算快照");
  const period = snapshot.period;
  const lines = await db.financeAllocationLine.findMany({
    where: {
      runId: run.id,
      OR: [{ targetUserId: userId }, { recipients: { some: { userId } } }],
      matter: { deletedAt: null, ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined) }
    },
    orderBy: [{ sourceOccurredAt: "asc" }, { id: "asc" }],
    select: {
      id: true, targetUserId: true, sourceKind: true, refundLinkId: true, sourceOccurredAt: true,
      grossAmount: true, channelAmount: true, firmAmount: true, sourceAmount: true, handlingAmount: true, coAmount: true,
      matter: { select: { internalCode: true, title: true } },
      payment: { select: { id: true } },
      recipients: { where: { userId }, select: { userId: true, role: true, amount: true } }
    }
  }) as AllocationLine[];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LawLink";
  workbook.created = new Date();
  addPersonalSnapshot(workbook, snapshot, run, period);
  addPersonalAllocations(workbook, lines, userId, run, period);
  styleWorkbook(workbook);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  return { bytes, snapshot, period, rowCount: lines.length };
}

function auditForExport(auditStrict: typeof auditStrictDefault, actor: FinanceSettlementActor, run: Run, period: string, scope: "ALL" | "OWN", rowCount: number, byteCount: number) {
  return auditStrict({
    userId: actor.id,
    action: "FINANCE_PERSONAL_SETTLEMENT_EXPORT",
    targetType: "FinanceCalculationRun",
    targetId: run.id,
    detail: { period, scope, rowCount, byteCount }
  });
}

export async function buildLawyerSettlementWorkbook(
  runId: string,
  userId: string,
  actor: FinanceSettlementActor,
  dependencies: FinanceSettlementDependencies = {}
): Promise<Buffer> {
  const scope = assertExport(actor, userId);
  const db = dependencies.db ?? prisma;
  const run = await committedRun(runId, db);
  const output = await buildWorkbookForUser(run, userId, actor, db);
  await auditForExport(dependencies.auditStrict ?? auditStrictDefault, actor, run, output.period, scope, output.rowCount, output.bytes.byteLength);
  return output.bytes;
}

export async function buildLawyerSettlementZip(
  runId: string,
  actor: FinanceSettlementActor,
  dependencies: FinanceSettlementDependencies = {}
): Promise<Buffer> {
  if (canExportActor(actor) !== "ALL") throw new ActionError("无全所律师结算导出权限");
  const db = dependencies.db ?? prisma;
  const run = await committedRun(runId, db);
  const snapshots = await db.financePersonPeriodSnapshot.findMany({ where: { runId: run.id }, select: { userId: true }, orderBy: { userId: "asc" } });
  const period = shDayKey(run.periodStart).slice(0, 7);
  const zip = new PizZip();
  const manifest = ["LawLink 律师个人结算包", `期间：${period}`, `正式批次：${run.id}`, `来源指纹：${run.sourceHash}`, "", `人员文件数：${snapshots.length}`];
  let rowCount = 0;
  for (const item of snapshots) {
    const output = await buildWorkbookForUser(run, item.userId, actor, db);
    rowCount += output.rowCount;
    const fileName = `律师结算-${period}-${masked(item.userId)}.xlsx`;
    zip.file(fileName, output.bytes);
    const digest = createHash("sha256").update(output.bytes).digest("hex");
    manifest.push(`${fileName} SHA-256 ${digest}`);
  }
  zip.file("MANIFEST.txt", manifest.join("\n"));
  const bytes = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  await auditForExport(dependencies.auditStrict ?? auditStrictDefault, actor, run, period, "ALL", rowCount, bytes.byteLength);
  return bytes;
}

export async function listAvailableSettlementRuns(
  actor: FinanceSettlementActor,
  dependencies: FinanceSettlementDependencies = {}
): Promise<AvailableSettlementRun[]> {
  const scope = canExportActor(actor);
  if (!scope) throw new ActionError("无个人结算导出权限");
  const db = dependencies.db ?? prisma;
  const runs = await db.financeCalculationRun.findMany({
    where: {
      status: "COMMITTED",
      ...(scope === "OWN" ? { personPeriodSnapshots: { some: { userId: actor.id } } } : {})
    },
    select: { id: true, periodStart: true, sourceHash: true, calculatedAt: true },
    orderBy: [{ periodStart: "desc" }, { calculatedAt: "desc" }],
    take: 50
  });
  return runs.map((run) => ({
    id: run.id,
    period: shDayKey(run.periodStart).slice(0, 7),
    sourceHash: run.sourceHash,
    calculatedAt: run.calculatedAt.toISOString()
  }));
}
