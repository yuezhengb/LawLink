import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { shDayKey } from "@/lib/ui/sh-time";
import type {
  FinanceColumnMapping,
  FinanceDirection,
  FinanceNormalizedRow,
  FinanceParseResult,
  FinanceRowError,
  FinanceSourceKind,
  FinanceImportIndexMapping,
  FinanceColumnMappingsBySheet
} from "@/lib/finance/internal-types";

type FinanceField = keyof FinanceColumnMapping;
type RawRecord = Record<string, unknown>;
type Matrix = string[][];
export type FinanceMatrixSheet = { name: string; matrix: Matrix };

type NormalizationOptions = {
  sourceKind: FinanceSourceKind;
  sourceSheet?: string;
  sourceRowNumber: number;
  sourceBatchId?: string;
  sourceFileId?: string;
};

const HEADER_ALIASES: Record<FinanceField, readonly string[]> = {
  occurredAt: ["日期", "交易日期", "记账日期", "发生日期", "入账日期", "交易时间", "date", "交易日"],
  counterparty: ["对方户名", "对方名称", "对方", "交易对方", "收款人", "付款人", "交易对手", "对方户名/名称"],
  debit: ["借方发生额", "借方金额", "借方", "支出", "支出金额", "付款", "付款金额", "转出金额"],
  credit: ["贷方发生额", "贷方金额", "贷方", "收入", "收入金额", "收款", "收款金额", "转入金额"],
  amount: ["金额", "交易金额", "发生额", "交易额", "金额(元)", "金额元"],
  balance: ["余额", "账户余额", "可用余额", "余额(元)", "余额元"],
  account: ["账号", "账户", "对方账号", "对方账户", "银行账号", "卡号"],
  description: ["摘要", "用途", "备注", "附言", "交易说明", "说明", "摘要/用途"],
  externalReference: ["流水号", "交易流水号", "参考号", "业务流水号", "外部流水号", "交易参考号"],
  invoiceReference: ["发票号", "发票号码", "票据号", "发票编号"]
};

const FIELDS = Object.keys(HEADER_ALIASES) as FinanceField[];

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeHeader(value: string): string {
  return normalizeWhitespace(value)
    .replace(/\*+$/, "")
    .replace(/[（(]\s*元\s*[）)]$/i, "")
    .replace(/[\s_\-]/g, "")
    .toLocaleLowerCase();
}

const ALIAS_TO_FIELD = new Map<string, FinanceField>();
for (const field of FIELDS) {
  for (const alias of HEADER_ALIASES[field]) {
    ALIAS_TO_FIELD.set(normalizeHeader(alias), field);
  }
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return shDayKey(value);
  if (typeof value === "object") {
    const objectValue = value as {
      result?: unknown;
      text?: unknown;
      richText?: Array<{ text?: unknown }>;
      hyperlink?: unknown;
    };
    if (Array.isArray(objectValue.richText)) {
      return normalizeWhitespace(objectValue.richText.map((item) => String(item.text ?? "")).join(""));
    }
    if (objectValue.text !== undefined) return normalizeWhitespace(String(objectValue.text));
    if (objectValue.result !== undefined) return cellToText(objectValue.result);
    if (objectValue.hyperlink !== undefined) return normalizeWhitespace(String(objectValue.hyperlink));
    return "";
  }
  return normalizeWhitespace(String(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function error(
  rowNumber: number,
  code: FinanceRowError["code"],
  message: string,
  field?: string
): FinanceRowError {
  return { rowNumber, code, field, message };
}

function asRecord(input: unknown): RawRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as RawRecord;
}

function mappedValue(record: RawRecord, mapping: FinanceColumnMapping, field: FinanceField): unknown {
  const key = mapping[field];
  return key ? record[key] : undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function civilDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function excelSerialDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 200000) return null;
  const milliseconds = Date.UTC(1899, 11, 30) + Math.floor(serial * 86_400_000);
  return shDayKey(new Date(milliseconds));
}

function normalizeOccurredAt(value: unknown): { value?: string; issue?: FinanceRowError["code"] } {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { issue: "INVALID_OCCURRED_AT" };
    return { value: shDayKey(value) };
  }

  const text = cellToText(value);
  if (!text) return { issue: "MISSING_OCCURRED_AT" };

  if (/^\d{8}$/.test(text)) {
    const date = civilDate(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
    return date ? { value: date } : { issue: "INVALID_OCCURRED_AT" };
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = excelSerialDate(Number(text));
    if (serial) return { value: serial };
  }

  const normalized = text
    .replace(/[年./]/g, "-")
    .replace(/[月]/g, "-")
    .replace(/[日]/g, "")
    .replace(/T.*/, "")
    .trim();
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return { issue: "INVALID_OCCURRED_AT" };
  const date = civilDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return date ? { value: date } : { issue: "INVALID_OCCURRED_AT" };
}

type ParsedMoney = {
  signed: string;
  absolute: string;
  negative: boolean;
  zero: boolean;
};

function parseMoney(value: unknown): ParsedMoney | "EMPTY" | "INVALID" {
  const original = cellToText(value);
  if (!original || /^[-—–]+$/.test(original)) return "EMPTY";

  const parenthesized = /^\(.*\)$/.test(original) || /^（.*）$/.test(original);
  let text = original.replace(/^[（(]|[）)]$/g, "");
  text = text
    .replace(/[￥¥元人民币]/g, "")
    .replace(/[，,\s]/g, "")
    .replace(/−/g, "-")
    .trim();
  if (!text) return "EMPTY";

  const negative = parenthesized || text.startsWith("-");
  text = text.replace(/^[+-]/, "");
  if (!/^\d+(?:\.\d+)?$/.test(text)) return "INVALID";
  const [integerPart, decimalPart = ""] = text.split(".");
  if (decimalPart.length > 2) return "INVALID";
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const absolute = `${integer}.${decimalPart.padEnd(2, "0")}`;
  const zero = /^0\.00$/.test(absolute);
  return {
    signed: `${negative && !zero ? "-" : ""}${absolute}`,
    absolute,
    negative: negative && !zero,
    zero
  };
}

function maskAccount(value: unknown): string | null {
  const text = cellToText(value).replace(/[\s-]/g, "");
  if (!text) return null;
  const suffix = text.slice(-4);
  return `****${suffix}`;
}

function normalizeOptionalText(value: unknown): string | null {
  const text = cellToText(value);
  return text ? text : null;
}

function invalidAmountError(rowNumber: number, field: string): FinanceRowError {
  return error(rowNumber, "INVALID_AMOUNT", `第 ${rowNumber} 行的${field}不是有效金额（最多保留两位小数）`, field);
}

export function normalizeFinanceRow(
  input: unknown,
  mapping: FinanceColumnMapping,
  options: NormalizationOptions
): FinanceNormalizedRow | FinanceRowError {
  const record = asRecord(input);
  const occurredAt = normalizeOccurredAt(mappedValue(record, mapping, "occurredAt"));
  if (occurredAt.issue) {
    return error(
      options.sourceRowNumber,
      occurredAt.issue,
      occurredAt.issue === "MISSING_OCCURRED_AT" ? `第 ${options.sourceRowNumber} 行缺少发生日期` : `第 ${options.sourceRowNumber} 行的发生日期无法识别`,
      "occurredAt"
    );
  }

  const debit = parseMoney(mappedValue(record, mapping, "debit"));
  const credit = parseMoney(mappedValue(record, mapping, "credit"));
  const generic = parseMoney(mappedValue(record, mapping, "amount"));
  const hasDebitCredit = debit !== "EMPTY" || credit !== "EMPTY";
  if (debit === "INVALID") return invalidAmountError(options.sourceRowNumber, "借方金额");
  if (credit === "INVALID") return invalidAmountError(options.sourceRowNumber, "贷方金额");
  if (generic === "INVALID" && !hasDebitCredit) return invalidAmountError(options.sourceRowNumber, "金额");

  let amount: string;
  let direction: FinanceDirection;
  if (hasDebitCredit) {
    if (debit !== "EMPTY" && credit !== "EMPTY" && !debit.zero && !credit.zero) {
      return error(options.sourceRowNumber, "INVALID_DIRECTION", `第 ${options.sourceRowNumber} 行同时存在借方和贷方金额`, "direction");
    }
    if (credit !== "EMPTY" && !credit.zero) {
      amount = credit.absolute;
      direction = "CREDIT";
    } else if (debit !== "EMPTY" && !debit.zero) {
      amount = `-${debit.absolute}`;
      direction = "DEBIT";
    } else {
      amount = "0.00";
      direction = "UNKNOWN";
    }
  } else {
    if (generic === "EMPTY") {
      return error(options.sourceRowNumber, "MISSING_AMOUNT", `第 ${options.sourceRowNumber} 行缺少金额`, "amount");
    }
    if (generic === "INVALID") return invalidAmountError(options.sourceRowNumber, "金额");
    amount = generic.signed;
    direction = generic.zero ? "UNKNOWN" : generic.negative ? "DEBIT" : "CREDIT";
  }

  const balanceValue = parseMoney(mappedValue(record, mapping, "balance"));
  if (balanceValue === "INVALID") return invalidAmountError(options.sourceRowNumber, "余额");
  const counterparty = normalizeOptionalText(mappedValue(record, mapping, "counterparty"));
  const description = normalizeOptionalText(mappedValue(record, mapping, "description"));
  const externalReference = normalizeOptionalText(mappedValue(record, mapping, "externalReference"));
  const invoiceReference = normalizeOptionalText(mappedValue(record, mapping, "invoiceReference"));

  return {
    sourceKind: options.sourceKind,
    sourceBatchId: options.sourceBatchId,
    sourceFileId: options.sourceFileId,
    sourceSheet: options.sourceSheet,
    sourceRowNumber: options.sourceRowNumber,
    occurredAt: occurredAt.value!,
    amount,
    direction,
    balance: balanceValue === "EMPTY" ? null : balanceValue.signed,
    counterparty,
    counterpartyDigest: counterparty ? hashText(counterparty) : null,
    accountMasked: maskAccount(mappedValue(record, mapping, "account")),
    description,
    descriptionDigest: description ? hashText(description) : null,
    externalReference,
    invoiceReference
  };
}

export function detectFinanceColumnMapping(headers: string[]): FinanceColumnMapping {
  const mapping: FinanceColumnMapping = {};
  for (const header of headers) {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(header));
    if (field && !mapping[field]) mapping[field] = header;
  }
  return mapping;
}

function nonEmptyRow(row: string[]): boolean {
  return row.some((cell) => normalizeWhitespace(cell).length > 0);
}

function mapMatrix(
  matrix: Matrix,
  fileName: string,
  kind: "BANK_STATEMENT",
  suppliedMapping?: FinanceColumnMapping,
  sourceSheet = "CSV",
  indexMapping?: FinanceImportIndexMapping
): FinanceParseResult {
  const firstDataRow = matrix.findIndex(nonEmptyRow);
  if (firstDataRow < 0) {
    return {
      fileName,
      kind,
      headers: [],
      rows: [],
      errors: [error(0, "EMPTY_WORKBOOK", "文件中没有可读取的数据")],
      totalRows: 0
    };
  }

  let headerIndex = firstDataRow;
  let detected = detectFinanceColumnMapping(matrix[headerIndex]);
  for (let index = firstDataRow; index < Math.min(matrix.length, firstDataRow + 20); index += 1) {
    const candidate = detectFinanceColumnMapping(matrix[index]);
    const candidateDensity = matrix[index].filter((cell) => normalizeWhitespace(cell).length > 0).length;
    const detectedDensity = matrix[headerIndex].filter((cell) => normalizeWhitespace(cell).length > 0).length;
    if (Object.keys(candidate).length > Object.keys(detected).length || (Object.keys(candidate).length === Object.keys(detected).length && candidateDensity > detectedDensity)) {
      headerIndex = index;
      detected = candidate;
    }
  }

  const headers = matrix[headerIndex].map((header) => normalizeWhitespace(header));
  const mapping: FinanceColumnMapping = { ...detected };
  const bankFields = new Set<FinanceField>(FIELDS);
  for (const [field, index] of Object.entries(indexMapping ?? {}) as Array<[keyof FinanceColumnMapping, number]>) {
    if (bankFields.has(field) && Number.isInteger(index) && index >= 0 && index < headers.length) {
      mapping[field] = `__finance_import_column_${index}`;
    }
  }
  Object.assign(mapping, suppliedMapping ?? {});
  if (Object.keys(mapping).length === 0) {
    return {
      fileName,
      kind,
      headers,
      rows: [],
      errors: [error(headerIndex + 1, "INVALID_COLUMN_MAPPING", "未识别到财务表头，请确认文件包含日期和金额等列")],
      totalRows: 0
    };
  }

  const rows: FinanceNormalizedRow[] = [];
  const errors: FinanceRowError[] = [];
  let totalRows = 0;
  for (let index = headerIndex + 1; index < matrix.length; index += 1) {
    const sourceRowNumber = index + 1;
    const values = matrix[index];
    if (!nonEmptyRow(values)) continue;
    totalRows += 1;
    const raw: RawRecord = {};
    headers.forEach((header, columnIndex) => {
      if (header) raw[header] = values[columnIndex] ?? "";
      raw[`__finance_import_column_${columnIndex}`] = values[columnIndex] ?? "";
    });
    const normalized = normalizeFinanceRow(raw, mapping, { sourceKind: kind, sourceSheet, sourceRowNumber });
    if ("code" in normalized) errors.push({ ...normalized, sourceSheet });
    else rows.push(normalized);
  }

  return { fileName, kind, headers, rows, errors, totalRows };
}

function parseCsv(text: string): Matrix {
  const rows: Matrix = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const content = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function readXlsxSheets(bytes: Buffer): Promise<FinanceMatrixSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets.map((sheet) => {
  const rows = new Map<number, Map<number, string>>();
  let maxRowNumber = 0;
  let maxColumnNumber = 0;

  // ExcelJS columnCount can be inflated by formatting-only cells. Iterate only
  // through populated cells, but retain original row numbers for audit errors.
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = new Map<number, string>();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const value = cellToText(cell.value);
      if (!value) return;
      values.set(columnNumber, value);
      maxColumnNumber = Math.max(maxColumnNumber, columnNumber);
    });
    if (values.size === 0) return;
    rows.set(row.number, values);
    maxRowNumber = Math.max(maxRowNumber, row.number);
  });

  if (maxRowNumber === 0 || maxColumnNumber === 0) return { name: sheet.name, matrix: [] };
  const matrix: Matrix = Array.from({ length: maxRowNumber }, () => Array(maxColumnNumber).fill(""));
  for (const [rowNumber, values] of rows) {
    for (const [columnNumber, value] of values) matrix[rowNumber - 1][columnNumber - 1] = value;
  }
  return { name: sheet.name, matrix };
  });
}

export async function readFinanceWorkbookSheets(bytes: Buffer, fileName: string): Promise<{ sheets: FinanceMatrixSheet[]; errors: FinanceRowError[] }> {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "xls") {
    return {
      sheets: [],
      errors: [error(0, "UNSUPPORTED_LEGACY_XLS", "传统 XLS 格式需要先通过隔离预处理服务转换为 XLSX。")]
    };
  }
  if (extension !== "csv" && extension !== "xlsx") {
    return { sheets: [], errors: [error(0, "UNSUPPORTED_FILE_FORMAT", "仅支持 CSV 或 XLSX 文件")] };
  }
  try {
    const sheets = extension === "csv"
      ? [{ name: "CSV", matrix: parseCsv(bytes.toString("utf8")) }]
      : await readXlsxSheets(bytes);
    if (!sheets.some((sheet) => sheet.matrix.some(nonEmptyRow))) {
      return { sheets: [], errors: [error(0, "EMPTY_WORKBOOK", "文件中没有可读取的数据")] };
    }
    return { sheets, errors: [] };
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "未知解析错误";
    return { sheets: [], errors: [error(0, "PARSE_FAILURE", `文件解析失败：${detail}`)] };
  }
}

export async function readFinanceMatrix(
  bytes: Buffer,
  fileName: string
): Promise<{ matrix: Matrix; errors: FinanceRowError[] }> {
  const result = await readFinanceWorkbookSheets(bytes, fileName);
  return { matrix: result.sheets[0]?.matrix ?? [], errors: result.errors };
}

export async function parseFinanceWorkbook(
  bytes: Buffer,
  fileName: string,
  kind: "BANK_STATEMENT",
  suppliedMapping?: FinanceColumnMapping,
  indexMappingsBySheet: FinanceColumnMappingsBySheet = {}
): Promise<FinanceParseResult> {
  const result = await readFinanceWorkbookSheets(bytes, fileName);
  if (result.errors.length > 0) return { fileName, kind, headers: [], rows: [], errors: result.errors, totalRows: 0 };
  const parsed = result.sheets.map((sheet) => mapMatrix(sheet.matrix, fileName, kind, suppliedMapping, sheet.name, indexMappingsBySheet[sheet.name]));
  const primary = parsed[0];
  return {
    ...primary,
    rows: parsed.flatMap((part) => part.rows),
    errors: parsed.flatMap((part) => part.errors),
    totalRows: parsed.reduce((sum, part) => sum + part.totalRows, 0)
  };
}
