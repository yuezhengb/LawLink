import type { FinanceExternalStatementImportRow, FinanceRowError } from "@/lib/finance/internal-types";
import { cell, columnIndex, onePeriod, parseMoney, parsePeriod, readTypedTable, rowError } from "@/lib/finance/typed-import-utils";

function statementKind(value: string): FinanceExternalStatementImportRow["statement"] | null {
  const text = value.replace(/[\s_\-]/g, "").toLocaleLowerCase();
  if (["资产负债表", "balance", "balancesheet", "balancesheetstatement"].includes(text)) return "BALANCE_SHEET";
  if (["利润表", "损益表", "income", "incomestatement", "profitandloss"].includes(text)) return "INCOME";
  if (["现金流量表", "cashflow", "cashflowstatement"].includes(text)) return "CASH_FLOW";
  return null;
}

export async function parseExternalStatementsWorkbook(bytes: Buffer, fileName: string, selectedPeriod?: string) {
  const table = await readTypedTable(bytes, fileName, ["period", "statement", "item", "amount"]);
  const errors: FinanceRowError[] = [...table.errors];
  const periodIndex = columnIndex(table.headers, "period");
  const statementIndex = columnIndex(table.headers, "statement");
  const itemIndex = columnIndex(table.headers, "item");
  const amountIndex = columnIndex(table.headers, "amount");
  const periods = table.rows.map((row) => {
    const raw = periodIndex >= 0 ? cell(row, periodIndex) : selectedPeriod ?? "";
    const period = parsePeriod(raw);
    if (!period) errors.push(rowError(row.sourceRowNumber, raw ? "INVALID_PERIOD" : "MISSING_PERIOD", "外部三表行账期无效或缺失", "period"));
    else if (selectedPeriod && selectedPeriod !== period) errors.push(rowError(row.sourceRowNumber, "INVALID_PERIOD", "文件账期与所选账期不一致", "period"));
    return period ?? "";
  });
  const period = onePeriod(periods, table.rows.map((row) => row.sourceRowNumber), errors);
  const rows: FinanceExternalStatementImportRow[] = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    const statement = statementKind(cell(row, statementIndex));
    const item = cell(row, itemIndex);
    const amount = parseMoney(cell(row, amountIndex), true);
    if (!statement) errors.push(rowError(row.sourceRowNumber, "INVALID_STATEMENT", "报表类型须为资产负债表、利润表或现金流量表", "statement"));
    if (!item) errors.push(rowError(row.sourceRowNumber, "INVALID_COLUMN_MAPPING", "外部三表行缺少项目/科目", "item"));
    if (amount === null) errors.push(rowError(row.sourceRowNumber, "INVALID_AMOUNT", "金额格式无效，最多支持两位小数", "amount"));
    if (period && statement && item && amount !== null) rows.push({ sourceRowNumber: row.sourceRowNumber, period, statement, item, amount });
  }
  const present = new Set(rows.map((row) => row.statement));
  const missing = (["BALANCE_SHEET", "INCOME", "CASH_FLOW"] as const).filter((kind) => !present.has(kind));
  return {
    fileName,
    kind: "EXTERNAL_THREE_STATEMENTS" as const,
    headers: table.headers,
    rows,
    errors,
    totalRows: table.totalRows,
    period: period ?? undefined,
    reviewWarnings: missing.length ? [`尚未包含：${missing.map((kind) => kind === "BALANCE_SHEET" ? "资产负债表" : kind === "INCOME" ? "利润表" : "现金流量表").join("、")}；不得视为完整外部三表。`] : []
  };
}
