import { createHash } from "node:crypto";
import type { FinanceColumnMapping, FinanceImportField, FinanceImportIndexMapping, FinanceSourceKind } from "@/lib/finance/internal-types";
import { TYPED_ALIASES, type TypedField } from "@/lib/finance/typed-import-utils";

export type { FinanceImportField, FinanceImportIndexMapping } from "@/lib/finance/internal-types";

export type FinanceColumnMappingSuggestion = {
  mapping: FinanceImportIndexMapping;
  missingFields: FinanceImportField[];
};

const BANK_ALIASES: Record<keyof FinanceColumnMapping, readonly string[]> = {
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

const REQUIRED_FIELDS: Partial<Record<FinanceSourceKind, readonly FinanceImportField[]>> = {
  BANK_STATEMENT: ["occurredAt"],
  PAYROLL: ["name", "salary", "actual", "selfCost"],
  ROSTER: ["name", "role"],
  EXTERNAL_THREE_STATEMENTS: ["period", "item", "amount"]
};

function candidateHeaders(matrix: string[][], kind: FinanceSourceKind): { headerRowNumber: number; headers: string[]; mapping: FinanceImportIndexMapping; missingFields: FinanceImportField[] } | null {
  let best: { headerRowNumber: number; headers: string[]; mapping: FinanceImportIndexMapping; missingFields: FinanceImportField[]; score: number; density: number } | null = null;
  for (let index = 0; index < Math.min(matrix.length, 30); index += 1) {
    const headers = matrix[index].map((value) => value.trim());
    const density = headers.filter(Boolean).length;
    if (!density) continue;
    const suggestion = suggestFinanceColumnMapping(kind, headers);
    const score = Object.keys(suggestion.mapping).length;
    if (!best || score > best.score || (score === best.score && density > best.density)) {
      best = { headerRowNumber: index + 1, headers, mapping: suggestion.mapping, missingFields: suggestion.missingFields, score, density };
    }
  }
  return best;
}

function normalizeHeader(value: string): string {
  return value.replace(/[\u0000\uFEFF]/g, "").replace(/[\s_\-（）()]/g, "").toLocaleLowerCase();
}

function aliasesFor(field: FinanceImportField): readonly string[] {
  return field in BANK_ALIASES
    ? BANK_ALIASES[field as keyof FinanceColumnMapping]
    : TYPED_ALIASES[field as TypedField];
}

function allFields(kind: FinanceSourceKind): FinanceImportField[] {
  if (kind === "BANK_STATEMENT") return Object.keys(BANK_ALIASES) as (keyof FinanceColumnMapping)[];
  if (kind === "OTHER") return [];
  return Object.keys(TYPED_ALIASES) as TypedField[];
}

export function suggestFinanceColumnMapping(kind: FinanceSourceKind, headers: string[]): FinanceColumnMappingSuggestion {
  const mapping: FinanceImportIndexMapping = {};
  for (const field of allFields(kind)) {
    const aliases = new Set(aliasesFor(field).map(normalizeHeader));
    const index = headers.findIndex((header) => aliases.has(normalizeHeader(header)));
    if (index >= 0) mapping[field] = index;
  }

  const required = REQUIRED_FIELDS[kind] ?? [];
  const missingFields = required.filter((field) => mapping[field] === undefined);
  if (kind === "BANK_STATEMENT" && (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined)) {
    missingFields.push("amount");
  }
  return { mapping, missingFields };
}

export function inspectFinanceHeader(kind: FinanceSourceKind, matrix: string[][]): {
  headerRowNumber: number;
  headers: string[];
  mapping: FinanceImportIndexMapping;
  missingFields: FinanceImportField[];
} | null {
  const result = candidateHeaders(matrix, kind);
  return result ? {
    headerRowNumber: result.headerRowNumber,
    headers: result.headers,
    mapping: result.mapping,
    missingFields: result.missingFields
  } : null;
}

export function applyFinanceColumnMapping(
  headers: string[],
  row: string[],
  explicitMapping: FinanceImportIndexMapping
): Partial<Record<FinanceImportField, string>> {
  const output: Partial<Record<FinanceImportField, string>> = {};
  for (const [field, index] of Object.entries(explicitMapping) as Array<[FinanceImportField, number]>) {
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) continue;
    output[field] = (row[index] ?? "").trim();
  }
  return output;
}

export function financeHeadersDigest(kind: FinanceSourceKind, headers: string[]): string {
  const canonical = headers.map(normalizeHeader);
  return createHash("sha256").update(JSON.stringify({ kind, headers: canonical })).digest("hex");
}
