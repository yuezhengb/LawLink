import type { FinanceColumnMappingsBySheet, FinancePayrollImportRow, FinanceRowError } from "@/lib/finance/internal-types";
import { cell, columnIndex, onePeriod, parseMoney, parsePeriod, readTypedTable, rowError } from "@/lib/finance/typed-import-utils";

export async function parsePayrollWorkbook(bytes: Buffer, fileName: string, selectedPeriod?: string, mappingsBySheet: FinanceColumnMappingsBySheet = {}) {
  const table = await readTypedTable(bytes, fileName, ["name", "salary", "actual", "selfCost"], mappingsBySheet);
  const errors: FinanceRowError[] = [...table.errors];
  if (errors.length) return { fileName, kind: "PAYROLL" as const, headers: table.headers, rows: [] as FinancePayrollImportRow[], errors, totalRows: table.totalRows, period: selectedPeriod };

  const periods = table.rows.map((row) => {
    const periodIndex = columnIndex(row.headers, "period", row.mapping);
    const raw = periodIndex >= 0 ? cell(row, periodIndex) : selectedPeriod ?? "";
    const parsed = parsePeriod(raw);
    if (!parsed) errors.push({ ...rowError(row.sourceRowNumber, raw ? "INVALID_PERIOD" : "MISSING_PERIOD", "工资行账期无效或缺失", "period"), sourceSheet: row.sourceSheet });
    else if (selectedPeriod && parsed !== selectedPeriod) errors.push({ ...rowError(row.sourceRowNumber, "INVALID_PERIOD", "文件账期与所选账期不一致", "period"), sourceSheet: row.sourceSheet });
    return parsed ?? "";
  });
  const period = onePeriod(periods, table.rows.map((row) => row.sourceRowNumber), errors);
  const rows: FinancePayrollImportRow[] = [];
  for (const row of table.rows) {
    const nameIndex = columnIndex(row.headers, "name", row.mapping);
    const salaryIndex = columnIndex(row.headers, "salary", row.mapping);
    const actualIndex = columnIndex(row.headers, "actual", row.mapping);
    const selfCostIndex = columnIndex(row.headers, "selfCost", row.mapping);
    const displayName = cell(row, nameIndex);
    const salaryText = cell(row, salaryIndex);
    const actualText = cell(row, actualIndex);
    const selfCostText = cell(row, selfCostIndex);
    if (!displayName) errors.push({ ...rowError(row.sourceRowNumber, "MISSING_NAME", "工资行缺少姓名", "name"), sourceSheet: row.sourceSheet });
    const declaredSalary = parseMoney(salaryText);
    const actualCashPaid = parseMoney(actualText);
    const selfCostDue = parseMoney(selfCostText);
    if (declaredSalary === null) errors.push({ ...rowError(row.sourceRowNumber, "INVALID_AMOUNT", "申报工资必须是非负且最多两位小数的金额", "salary"), sourceSheet: row.sourceSheet });
    if (actualCashPaid === null) errors.push({ ...rowError(row.sourceRowNumber, "INVALID_AMOUNT", "实际支付必须是非负且最多两位小数的金额", "actual"), sourceSheet: row.sourceSheet });
    if (selfCostDue === null) errors.push({ ...rowError(row.sourceRowNumber, "INVALID_AMOUNT", "自担成本必须是非负且最多两位小数的金额", "selfCost"), sourceSheet: row.sourceSheet });
    const rowPeriod = periods[table.rows.indexOf(row)];
    if (period && rowPeriod && displayName && declaredSalary !== null && actualCashPaid !== null && selfCostDue !== null) {
      rows.push({ sourceSheet: row.sourceSheet, sourceRowNumber: row.sourceRowNumber, period, displayName, declaredSalary, actualCashPaid, selfCostDue });
    }
  }
  return { fileName, kind: "PAYROLL" as const, headers: table.headers, rows, errors, totalRows: table.totalRows, period: period ?? undefined, reviewWarnings: table.reviewWarnings };
}
