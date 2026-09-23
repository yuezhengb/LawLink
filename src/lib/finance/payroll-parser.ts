import type { FinancePayrollImportRow, FinanceRowError } from "@/lib/finance/internal-types";
import { cell, columnIndex, onePeriod, parseMoney, parsePeriod, readTypedTable, rowError } from "@/lib/finance/typed-import-utils";

export async function parsePayrollWorkbook(bytes: Buffer, fileName: string, selectedPeriod?: string) {
  const table = await readTypedTable(bytes, fileName, ["name", "salary", "actual", "selfCost"]);
  const errors: FinanceRowError[] = [...table.errors];
  if (errors.length) return { fileName, kind: "PAYROLL" as const, headers: table.headers, rows: [] as FinancePayrollImportRow[], errors, totalRows: table.totalRows, period: selectedPeriod };

  const periodIndex = columnIndex(table.headers, "period");
  const nameIndex = columnIndex(table.headers, "name");
  const salaryIndex = columnIndex(table.headers, "salary");
  const actualIndex = columnIndex(table.headers, "actual");
  const selfCostIndex = columnIndex(table.headers, "selfCost");
  const periods = table.rows.map((row) => {
    const raw = periodIndex >= 0 ? cell(row, periodIndex) : selectedPeriod ?? "";
    const parsed = parsePeriod(raw);
    if (!parsed) errors.push(rowError(row.sourceRowNumber, raw ? "INVALID_PERIOD" : "MISSING_PERIOD", "工资行账期无效或缺失", "period"));
    else if (selectedPeriod && parsed !== selectedPeriod) errors.push(rowError(row.sourceRowNumber, "INVALID_PERIOD", "文件账期与所选账期不一致", "period"));
    return parsed ?? "";
  });
  const period = onePeriod(periods, table.rows.map((row) => row.sourceRowNumber), errors);
  const rows: FinancePayrollImportRow[] = [];
  for (const row of table.rows) {
    const displayName = cell(row, nameIndex);
    const salaryText = cell(row, salaryIndex);
    const actualText = cell(row, actualIndex);
    const selfCostText = cell(row, selfCostIndex);
    if (!displayName) errors.push(rowError(row.sourceRowNumber, "MISSING_NAME", "工资行缺少姓名", "name"));
    const declaredSalary = parseMoney(salaryText);
    const actualCashPaid = parseMoney(actualText);
    const selfCostDue = parseMoney(selfCostText);
    if (declaredSalary === null) errors.push(rowError(row.sourceRowNumber, "INVALID_AMOUNT", "申报工资必须是非负且最多两位小数的金额", "salary"));
    if (actualCashPaid === null) errors.push(rowError(row.sourceRowNumber, "INVALID_AMOUNT", "实际支付必须是非负且最多两位小数的金额", "actual"));
    if (selfCostDue === null) errors.push(rowError(row.sourceRowNumber, "INVALID_AMOUNT", "自担成本必须是非负且最多两位小数的金额", "selfCost"));
    const rowPeriod = periods[table.rows.indexOf(row)];
    if (period && rowPeriod && displayName && declaredSalary !== null && actualCashPaid !== null && selfCostDue !== null) {
      rows.push({ sourceRowNumber: row.sourceRowNumber, period, displayName, declaredSalary, actualCashPaid, selfCostDue });
    }
  }
  return { fileName, kind: "PAYROLL" as const, headers: table.headers, rows, errors, totalRows: table.totalRows, period: period ?? undefined };
}
