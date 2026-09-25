import {
  parseFinanceWorkbook,
  readFinanceMatrix
} from "@/lib/finance/import-parser";
import {
  parseExternalStatementsWorkbook
} from "@/lib/finance/external-statements-parser";
import { parsePayrollWorkbook } from "@/lib/finance/payroll-parser";
import { parseRosterWorkbook } from "@/lib/finance/roster-parser";
import type {
  FinanceSourceKind,
  FinanceSourceParseOptions,
  FinanceSourceParseResult
} from "@/lib/finance/internal-types";

export async function parseFinanceSource(
  bytes: Buffer,
  fileName: string,
  kind: FinanceSourceKind,
  options: FinanceSourceParseOptions = {}
): Promise<FinanceSourceParseResult> {
  if (kind === "BANK_STATEMENT") return parseFinanceWorkbook(bytes, fileName, kind, options.mapping, options.columnMappingsBySheet);
  if (kind === "PAYROLL") return parsePayrollWorkbook(bytes, fileName, options.period, options.columnMappingsBySheet);
  if (kind === "ROSTER") return parseRosterWorkbook(bytes, fileName, options.asOfDay, options.columnMappingsBySheet);
  if (kind === "EXTERNAL_THREE_STATEMENTS") return parseExternalStatementsWorkbook(bytes, fileName, options.period, options.columnMappingsBySheet);
  const table = await readFinanceMatrix(bytes, fileName);
  const nonEmptyRows = table.matrix.filter((row) => row.some((cell) => cell.trim().length > 0));
  const errors = [...table.errors];
  if (!errors.length && !options.period) errors.push({ rowNumber: 0, code: "MISSING_PERIOD", message: "归档其他资料时请指定账期" });
  return {
    fileName,
    kind: "OTHER",
    headers: table.matrix[0] ?? [],
    rows: [],
    errors,
    totalRows: Math.max(0, nonEmptyRows.length - 1),
    period: options.period,
    reviewWarnings: ["其他资料仅归档原始文件，不会进入银行对账或财务计算。"]
  };
}
