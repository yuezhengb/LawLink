import { readFinanceMatrix } from "@/lib/finance/import-parser";
import type { FinanceRowError } from "@/lib/finance/internal-types";

export type TypedTableRow = { sourceRowNumber: number; values: string[] };
export type TypedTable = { headers: string[]; rows: TypedTableRow[]; errors: FinanceRowError[]; totalRows: number };
export type TypedField = "period" | "name" | "salary" | "actual" | "selfCost" | "role" | "statement" | "item" | "amount";

export const TYPED_ALIASES: Record<TypedField, readonly string[]> = {
  period: ["期间", "月份", "账期", "工资月份", "会计期间"],
  name: ["姓名", "员工姓名", "人员姓名", "人员", "律师姓名"],
  salary: ["申报工资", "应发工资", "工资标准", "工资金额", "申报薪资"],
  actual: ["实际支付", "实发工资", "实付工资", "实际支付工资", "现金实付"],
  selfCost: ["自担社保", "个人承担社保", "个人社保", "律师自担成本", "自担成本"],
  role: ["身份", "人员身份", "岗位", "职务", "角色"],
  statement: ["报表", "报表类型", "报表名称", "表名"],
  item: ["项目", "科目", "项目名称", "科目名称"],
  amount: ["金额", "期末金额", "本期金额", "余额", "数值"]
};

function normalizeHeader(value: string): string {
  return value.replace(/[\s_\-]/g, "").replace(/[（）()]/g, "").toLocaleLowerCase();
}

export async function readTypedTable(bytes: Buffer, fileName: string, required: TypedField[]): Promise<TypedTable> {
  const result = await readFinanceMatrix(bytes, fileName);
  if (result.errors.length > 0) return { headers: [], rows: [], errors: result.errors, totalRows: 0 };
  const matrix = result.matrix;
  let headerIndex = -1;
  let bestScore = -1;
  const start = matrix.findIndex((row) => row.some((cell) => cell.trim().length > 0));
  for (let index = start; index < Math.min(matrix.length, start + 20); index += 1) {
    const candidate = new Set(matrix[index].map(normalizeHeader));
    const score = required.reduce((count, field) => count + Number(TYPED_ALIASES[field].some((alias) => candidate.has(normalizeHeader(alias)))), 0);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
    }
  }
  if (headerIndex < 0 || bestScore < required.length) {
    return { headers: [], rows: [], errors: [{ rowNumber: Math.max(1, start + 1), code: "INVALID_COLUMN_MAPPING", message: "未识别到该类资料所需的表头" }], totalRows: 0 };
  }
  const headers = matrix[headerIndex].map((value) => value.trim());
  const rows: TypedTableRow[] = [];
  for (let index = headerIndex + 1; index < matrix.length; index += 1) {
    const values = matrix[index];
    if (values.some((cell) => cell.trim().length > 0)) rows.push({ sourceRowNumber: index + 1, values });
  }
  return { headers, rows, errors: [], totalRows: rows.length };
}

export function columnIndex(headers: string[], field: TypedField): number {
  const aliases = new Set(TYPED_ALIASES[field].map(normalizeHeader));
  return headers.findIndex((header) => aliases.has(normalizeHeader(header)));
}

export function cell(row: TypedTableRow, index: number): string {
  return index < 0 ? "" : (row.values[index] ?? "").trim();
}

export function parsePeriod(value: string): string | null {
  const normalized = value.trim().replace(/[年月]/g, (part) => part === "年" ? "-" : "").replace(/月$/, "");
  const match = /^(\d{4})[-/.]?(0?[1-9]|1[0-2])(?:[-/.]\d{1,2})?$/.exec(normalized);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}` : null;
}

export function parseDay(value: string): string | null {
  const normalized = value.trim().replace(/[/.]/g, "-");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function parseMoney(value: string, allowNegative = false): string | null {
  const normalized = value.trim().replace(/[￥¥元\s]/g, "");
  const match = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  if (match[1] === "-" && !allowNegative) return null;
  const integer = match[2].replace(/,/g, "");
  if (integer.length > 12) return null;
  return `${match[1]}${integer}.${(match[3] ?? "").padEnd(2, "0") || "00"}`;
}

export function rowError(rowNumber: number, code: FinanceRowError["code"], message: string, field?: string): FinanceRowError {
  return { rowNumber, code, field, message };
}

export function onePeriod(values: string[], rowNumbers: number[], errors: FinanceRowError[]): string | null {
  const distinct = [...new Set(values)];
  if (distinct.length === 0 || distinct.some((value) => !value)) {
    errors.push(rowError(rowNumbers[0] ?? 0, "MISSING_PERIOD", "请提供账期，格式为 YYYY-MM", "period"));
    return null;
  }
  if (distinct.length > 1) {
    errors.push(rowError(rowNumbers[0] ?? 0, "INVALID_PERIOD", "同一导入文件包含多个账期，请按月拆分后导入", "period"));
    return null;
  }
  return distinct[0];
}
