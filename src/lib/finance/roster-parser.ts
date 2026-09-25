import type { FinanceColumnMappingsBySheet, FinanceRosterImportRow, FinanceRowError } from "@/lib/finance/internal-types";
import { cell, columnIndex, parseDay, readTypedTable, rowError } from "@/lib/finance/typed-import-utils";

export async function parseRosterWorkbook(bytes: Buffer, fileName: string, selectedAsOfDay?: string, mappingsBySheet: FinanceColumnMappingsBySheet = {}) {
  const table = await readTypedTable(bytes, fileName, ["name", "role"], mappingsBySheet);
  const errors: FinanceRowError[] = [...table.errors];
  const asOfDay = selectedAsOfDay ? parseDay(selectedAsOfDay) : null;
  if (!table.errors.length && !asOfDay) errors.push(rowError(0, "MISSING_AS_OF_DAY", "请在上传表单中指定花名册截至日期", "asOfDay"));
  const rows: FinanceRosterImportRow[] = [];
  for (const row of table.rows) {
    const nameIndex = columnIndex(row.headers, "name", row.mapping);
    const roleIndex = columnIndex(row.headers, "role", row.mapping);
    const displayName = cell(row, nameIndex);
    const roleLabel = cell(row, roleIndex);
    if (!displayName) errors.push({ ...rowError(row.sourceRowNumber, "MISSING_NAME", "花名册行缺少姓名", "name"), sourceSheet: row.sourceSheet });
    if (!roleLabel) errors.push({ ...rowError(row.sourceRowNumber, "INVALID_COLUMN_MAPPING", "花名册行缺少身份/岗位", "role"), sourceSheet: row.sourceSheet });
    if (asOfDay && displayName && roleLabel) rows.push({ sourceSheet: row.sourceSheet, sourceRowNumber: row.sourceRowNumber, asOfDay, displayName, roleLabel });
  }
  const names = rows.map((row) => row.displayName.trim().toLocaleLowerCase());
  const hasDuplicateNames = names.some((name, index) => names.indexOf(name) !== index);
  return {
    fileName,
    kind: "ROSTER" as const,
    headers: table.headers,
    rows,
    errors,
    totalRows: table.totalRows,
    asOfDay: asOfDay ?? undefined,
    reviewWarnings: [...table.reviewWarnings, ...(hasDuplicateNames ? ["存在同名人员，归档后必须人工匹配，不会自动关联到系统用户。"] : [])]
  };
}
