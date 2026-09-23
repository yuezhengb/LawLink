import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { getInternalFinanceSummary, type FinanceReportQuery, type FinanceReportsDependencies } from "@/server/finance/internal-reports";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
function numberValue(value: string): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function addMeta(sheet: ExcelJS.Worksheet, calculationRunId: string | null, sourceHash: string | null, start: string, end: string): void {
  sheet.addRow(["计算批次", calculationRunId ?? "无已提交批次", "来源指纹", sourceHash ?? "无", "来源期间", `${start} 至 ${end}`]);
  sheet.getRow(1).font = { bold: true };
}

function formatAmountColumns(sheet: ExcelJS.Worksheet, startColumn: number): void {
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    for (let column = startColumn; column <= sheet.columnCount; column += 1) {
      sheet.getCell(row, column).numFmt = "#,##0.00";
    }
  }
}

export async function buildFinanceWorkbook(
  input: FinanceReportQuery,
  dependencies: FinanceReportsDependencies = {}
): Promise<Buffer> {
  const summary = await getInternalFinanceSummary(input, dependencies);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LawLink";
  workbook.created = new Date();

  const persons = workbook.addWorksheet("人员透支表");
  addMeta(persons, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  persons.addRow(["人员ID", "人员", "总收入", "渠道", "律所", "案源", "承办", "协办"]);
  summary.persons.forEach((person) => persons.addRow([
    person.userId ? `****${person.userId.slice(-6)}` : "",
    person.userName,
    numberValue(person.grossIncome),
    numberValue(person.channelAmount),
    numberValue(person.firmAmount),
    numberValue(person.sourceAmount),
    numberValue(person.handlingAmount),
    numberValue(person.coAmount)
  ]));
  formatAmountColumns(persons, 3);

  const projects = workbook.addWorksheet("客户项目归属");
  addMeta(projects, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  projects.addRow(["案件ID", "所内案号", "案件", "客户引用", "来源类型", "发生日期", "付款引用", "退款关联", "本期金额", "渠道", "律所", "案源", "承办", "协办"]);
  summary.projects.forEach((project) => project.lines.forEach((line) => projects.addRow([
    `****${project.matterId.slice(-6)}`,
    project.matterCode,
    project.matterTitle,
    project.clientReference ?? "",
    line.sourceKind === "REFUND" ? "退款冲回" : "律师费收款",
    line.sourceOccurredAt.slice(0, 10),
    `****${line.sourcePaymentId.slice(-6)}`,
    line.refundLinkId ? `****${line.refundLinkId.slice(-6)}` : "",
    numberValue(line.grossAmount),
    numberValue(line.channelAmount),
    numberValue(line.firmAmount),
    numberValue(line.sourceAmount),
    numberValue(line.handlingAmount),
    numberValue(line.coAmount)
  ])));
  formatAmountColumns(projects, 9);

  const projectFacts = workbook.addWorksheet("案件金额概览");
  addMeta(projectFacts, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  projectFacts.addRow(["案件ID", "所内案号", "案件", "案件标的额", "现行签约律师费", "累计已开票净额", "累计确认净收款", "本期分配净额（含退款）"]);
  summary.projects.forEach((project) => projectFacts.addRow([
    `****${project.matterId.slice(-6)}`, project.matterCode, project.matterTitle,
    project.claimAmount === null ? "未录入" : numberValue(project.claimAmount),
    project.signedContractAmount === null ? "未登记" : numberValue(project.signedContractAmount),
    numberValue(project.issuedInvoiceNetAmount), numberValue(project.confirmedNetReceiptAmount), numberValue(project.periodAllocationAmount)
  ]));
  formatAmountColumns(projectFacts, 4);

  const firm = workbook.addWorksheet("律所经营成果");
  addMeta(firm, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  firm.addRow(["律师费收入", "渠道", "律所留存", "律师分配", "经营成果"]);
  firm.addRow([
    numberValue(summary.firm.feeRevenue),
    numberValue(summary.firm.channelAmount),
    numberValue(summary.firm.firmAmount),
    numberValue(summary.firm.lawyerAmount),
    summary.firm.operatingResult === null ? "待核对律所成本" : numberValue(summary.firm.operatingResult)
  ]);
  formatAmountColumns(firm, 1);

  const sources = workbook.addWorksheet("来源与对账");
  addMeta(sources, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  sources.addRow(["案件引用", "付款引用", "金额", "决定备注"]);
  summary.projects.forEach((project) => project.lines.forEach((line) => sources.addRow([
    `****${project.matterId.slice(-6)}`,
    `****${line.sourcePaymentId.slice(-6)}`,
    numberValue(line.grossAmount),
    "请回到对账队列查看"
  ])));
  formatAmountColumns(sources, 3);

  const adjustments = workbook.addWorksheet("调整审计");
  addMeta(adjustments, summary.calculationRunId, summary.sourceHash, summary.sourcePeriod.start, summary.sourcePeriod.end);
  adjustments.addRow(["调整凭证引用", "期间", "金额", "状态", "原因"]);
  formatAmountColumns(adjustments, 3);

  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 2 }];
    sheet.columns.forEach((column) => {
      column.width = Math.max(12, Math.min(28, (column.header ? String(column.header).length : 12) + 4));
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export type CloseWorkbookKind = "WAGE" | "ACCOUNTANT" | "PERSONAL" | "ADJUSTMENT_AUDIT";

function closeFileName(kind: CloseWorkbookKind, period: string): string {
  if (kind === "WAGE") return `工资-${period}.xlsx`;
  if (kind === "ACCOUNTANT") return `会计资料-${period}.xlsx`;
  if (kind === "PERSONAL") return `个人内账-${period}.xlsx`;
  return `调整审计-${period}.xlsx`;
}

function styleWorkbook(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 2 }];
    sheet.columns.forEach((column) => {
      column.width = Math.max(12, Math.min(32, (column.header ? String(column.header).length : 12) + 4));
    });
  }
}

function financeExportActor(actor?: FinanceReportsDependencies["actor"]): Promise<NonNullable<FinanceReportsDependencies["actor"]>> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.export").then((session) => ({ id: session.user.id, role: session.user.role, rolePermissions: session.user.rolePermissions as RoleGrant[] | null }));
}

export async function buildCloseWorkbook(
  kind: CloseWorkbookKind,
  runId: string,
  dependencies: FinanceReportsDependencies = {}
): Promise<Buffer> {
  const actor = await financeExportActor(dependencies.actor);
  const canExport = actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.export") === "ALL");
  if (!canExport) throw new Error("无财务导出权限");
  const db = dependencies.db ?? prisma;
  const run = await db.financeCalculationRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, periodStart: true, periodEnd: true, sourceHash: true }
  });
  if (!run || run.status !== "COMMITTED") throw new Error("正式财务批次不存在或未提交");
  const summary = await getInternalFinanceSummary({ start: run.periodStart, end: run.periodEnd, groupBy: "ALL", runId }, { ...dependencies, actor });
  if (summary.calculationRunId !== runId || summary.sourceHash !== run.sourceHash) throw new Error("无法读取与月结一致的正式快照");

  const period = shDayKey(run.periodStart).slice(0, 7);
  const periodStart = shDayKey(run.periodStart);
  const periodEnd = shDayKey(run.periodEnd);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LawLink";
  workbook.created = new Date();
  const meta = (sheet: ExcelJS.Worksheet) => addMeta(sheet, run.id, run.sourceHash, periodStart, periodEnd);

  if (kind === "WAGE") {
    const sheet = workbook.addWorksheet("工资与实付核对");
    meta(sheet);
    sheet.addRow(["人员ID", "人员", "申报工资", "实际支付现金", "视同工资", "个人自担成本", "律所工资成本", "律所社保成本", "律所公积金成本", "口径已复核", "复核说明"]);
    const payroll = await db.financePayrollFact.findMany({ where: { period }, include: { user: { select: { id: true, name: true } } }, orderBy: { userId: "asc" } });
    for (const row of payroll) sheet.addRow([
      `****${row.userId.slice(-6)}`, row.user.name, Number(row.grossSalary), Number(row.actualCashPaid), row.isDeemedWage ? "是" : "否",
      Number(row.selfCostDue), Number(row.firmSalaryCost), Number(row.firmSocialCost), Number(row.firmFundCost), row.treatmentReviewed ? "是" : "否", row.treatmentNote ?? ""
    ]);
    formatAmountColumns(sheet, 3);
  } else if (kind === "ACCOUNTANT") {
    const operating = workbook.addWorksheet("内部经营核对");
    meta(operating);
    operating.addRow(["律师费收入", "渠道费用", "律所留存", "律师分配", "律所经营结果"]);
    operating.addRow([Number(summary.firm.feeRevenue), Number(summary.firm.channelAmount), Number(summary.firm.firmAmount), Number(summary.firm.lawyerAmount), summary.firm.operatingResult === null ? "待核对" : Number(summary.firm.operatingResult)]);
    formatAmountColumns(operating, 1);
    const external = workbook.addWorksheet("外部三表核对");
    meta(external);
    external.addRow(["报表", "科目/项目", "金额", "系统状态"]);
    const externalRows = await db.financeImportRecord.findMany({ where: { period, kind: "EXTERNAL_THREE_STATEMENTS" }, orderBy: [{ statement: "asc" }, { sourceRow: "asc" }] });
    externalRows.forEach((row) => external.addRow([row.statement ?? "", row.item ?? "", row.amount === null ? "" : Number(row.amount), row.reviewStatus === "RESOLVED" ? "已复核" : "待人工复核"]));
    formatAmountColumns(external, 3);
    const projectFacts = workbook.addWorksheet("案件金额核对");
    meta(projectFacts);
    projectFacts.addRow(["所内案号", "案件", "案件标的额", "现行签约律师费", "累计已开票净额", "累计确认净收款", "本期分配净额（含退款）"]);
    summary.projects.forEach((project) => projectFacts.addRow([
      project.matterCode, project.matterTitle,
      project.claimAmount === null ? "未录入" : numberValue(project.claimAmount),
      project.signedContractAmount === null ? "未登记" : numberValue(project.signedContractAmount),
      numberValue(project.issuedInvoiceNetAmount), numberValue(project.confirmedNetReceiptAmount), numberValue(project.periodAllocationAmount),
    ]));
    formatAmountColumns(projectFacts, 3);
    const projects = workbook.addWorksheet("本期案件收款分配");
    meta(projects);
    projects.addRow(["所内案号", "案件", "来源类型", "发生日期", "付款引用", "退款关联", "本期分配净额", "渠道", "律所", "律师池"]);
    summary.projects.forEach((project) => project.lines.forEach((line) => projects.addRow([
      project.matterCode, project.matterTitle, line.sourceKind === "REFUND" ? "退款冲回" : "律师费收款", line.sourceOccurredAt.slice(0, 10),
      `****${line.sourcePaymentId.slice(-6)}`, line.refundLinkId ? `****${line.refundLinkId.slice(-6)}` : "", numberValue(line.grossAmount), numberValue(line.channelAmount), numberValue(line.firmAmount), Number(line.sourceAmount) + Number(line.handlingAmount) + Number(line.coAmount)
    ])));
    formatAmountColumns(projects, 7);
  } else if (kind === "PERSONAL") {
    const sheet = workbook.addWorksheet("个人双余额快照");
    meta(sheet);
    sheet.addRow(["人员ID", "人员", "期初可分配", "期初预存", "本期所得", "自担成本", "本期预存", "预存承担成本", "收入承担成本", "实际提款", "合伙人税款预付", "期末可分配", "期末预存", "预存缺口"]);
    const snapshots = await db.financePersonPeriodSnapshot.findMany({ where: { runId }, include: { user: { select: { name: true } } }, orderBy: { userId: "asc" } });
    snapshots.forEach((row) => sheet.addRow([
      `****${row.userId.slice(-6)}`, row.user.name, Number(row.openingDistributable), Number(row.openingReserve), Number(row.earned), Number(row.selfCostDue), Number(row.selfFundingIn), Number(row.selfFundingUsed), Number(row.selfCostChargedToIncome), Number(row.withdrawn), Number(row.partnerTaxAdvance), Number(row.distributableEnd), Number(row.reserveEnd), Number(row.reserveGap)
    ]));
    formatAmountColumns(sheet, 3);
  } else {
    const sheet = workbook.addWorksheet("调整与冲销审计");
    meta(sheet);
    sheet.addRow(["凭证引用", "科目", "目标人员引用", "金额", "状态", "冲销原凭证", "理由", "创建时间"]);
    const adjustments = await db.financeAdjustment.findMany({ where: { period }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    adjustments.forEach((row) => sheet.addRow([
      `****${row.id.slice(-6)}`, row.account, row.targetUserId ? `****${row.targetUserId.slice(-6)}` : "", Number(row.amount), String(row.status), row.reversalOfId ? `****${row.reversalOfId.slice(-6)}` : "", row.reason, row.createdAt.toISOString()
    ]));
    formatAmountColumns(sheet, 4);
  }
  styleWorkbook(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildCloseZip(
  period: string,
  runId: string,
  files: Record<CloseWorkbookKind, Buffer>,
  sourceHash: string
): Buffer {
  const zip = new PizZip();
  const order: CloseWorkbookKind[] = ["WAGE", "ACCOUNTANT", "PERSONAL", "ADJUSTMENT_AUDIT"];
  const lines = ["LawLink 律所内部财务月结包", `期间：${period}`, `正式批次：${runId}`, `来源指纹：${sourceHash}`, "", "各工作簿均为本期独立核对文件："];
  for (const kind of order) {
    const fileName = closeFileName(kind, period);
    const bytes = files[kind];
    zip.file(fileName, bytes);
    lines.push(`${fileName}  SHA-256 ${createSha256(bytes)}`);
  }
  zip.file("README.txt", lines.join("\n"));
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

function createSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
