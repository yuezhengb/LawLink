import ExcelJS from "exceljs";
import { getInternalFinanceSummary, type FinanceReportQuery, type FinanceReportsDependencies } from "@/server/finance/internal-reports";

function numberValue(value: string): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function addMeta(sheet: ExcelJS.Worksheet, calculationRunId: string | null, start: string, end: string): void {
  sheet.addRow(["计算批次", calculationRunId ?? "无已提交批次", "来源期间", `${start} 至 ${end}`]);
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
  addMeta(persons, summary.calculationRunId, summary.sourcePeriod.start, summary.sourcePeriod.end);
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
  addMeta(projects, summary.calculationRunId, summary.sourcePeriod.start, summary.sourcePeriod.end);
  projects.addRow(["案件ID", "所内案号", "案件", "客户引用", "付款引用", "总额", "渠道", "律所", "案源", "承办", "协办"]);
  summary.projects.forEach((project) => project.lines.forEach((line) => projects.addRow([
    `****${project.matterId.slice(-6)}`,
    project.matterCode,
    project.matterTitle,
    project.clientReference ?? "",
    `****${line.sourcePaymentId.slice(-6)}`,
    numberValue(line.grossAmount),
    numberValue(line.channelAmount),
    numberValue(line.firmAmount),
    numberValue(line.sourceAmount),
    numberValue(line.handlingAmount),
    numberValue(line.coAmount)
  ])));
  formatAmountColumns(projects, 6);

  const firm = workbook.addWorksheet("律所经营成果");
  addMeta(firm, summary.calculationRunId, summary.sourcePeriod.start, summary.sourcePeriod.end);
  firm.addRow(["律师费收入", "渠道", "律所留存", "律师分配", "经营成果"]);
  firm.addRow([
    numberValue(summary.firm.feeRevenue),
    numberValue(summary.firm.channelAmount),
    numberValue(summary.firm.firmAmount),
    numberValue(summary.firm.lawyerAmount),
    numberValue(summary.firm.operatingResult)
  ]);
  formatAmountColumns(firm, 1);

  const sources = workbook.addWorksheet("来源与对账");
  addMeta(sources, summary.calculationRunId, summary.sourcePeriod.start, summary.sourcePeriod.end);
  sources.addRow(["案件引用", "付款引用", "金额", "决定备注"]);
  summary.projects.forEach((project) => project.lines.forEach((line) => sources.addRow([
    `****${project.matterId.slice(-6)}`,
    `****${line.sourcePaymentId.slice(-6)}`,
    numberValue(line.grossAmount),
    "请回到对账队列查看"
  ])));
  formatAmountColumns(sources, 3);

  const adjustments = workbook.addWorksheet("调整审计");
  addMeta(adjustments, summary.calculationRunId, summary.sourcePeriod.start, summary.sourcePeriod.end);
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
