import { inspectFinanceHeader } from "@/lib/finance/import-mapping";
import type { FinanceSourceKind } from "@/lib/finance/internal-types";

export type PrivateStagingKind = FinanceSourceKind | "MIXED" | "UNCLASSIFIED";

export type PrivateStagingEntry = {
  extension: string;
  sha256: string;
  kind: PrivateStagingKind;
  needsPreprocessing: boolean;
  unreadable: boolean;
  unsupported: boolean;
};

export type PrivateStagingSummary = {
  totalFiles: number;
  duplicateContentFiles: number;
  needsPreprocessing: number;
  unreadableFiles: number;
  unsupportedFiles: number;
  byExtension: Record<string, number>;
  byKind: Record<PrivateStagingKind, number>;
};

export type PrivateFinanceParseEntry = {
  kind: Exclude<PrivateStagingKind, "MIXED" | "UNCLASSIFIED" | "OTHER">;
  sha256: string;
  rowCount: number;
  errorCodes: string[];
  errorFields: string[];
  errorShapes: string[];
  periods: string[];
};

export type PrivateFinanceParseSummary = {
  byKind: Record<Exclude<PrivateStagingKind, "MIXED" | "UNCLASSIFIED" | "OTHER">, {
    files: number;
    cleanFiles: number;
    blockedFiles: number;
    rowsInCleanFiles: number;
    duplicateFiles: number;
    parsedRows: number;
    errorCount: number;
    multiPeriodFiles: number;
    errorCodes: Record<string, number>;
    errorFields: Record<string, number>;
    errorShapes: Record<string, number>;
    byPeriod: Record<string, number>;
  }>;
};

const STRUCTURED_KINDS = ["BANK_STATEMENT", "PAYROLL", "ROSTER", "EXTERNAL_THREE_STATEMENTS"] as const;

export type PrivateCellShape = "EMPTY" | "VALID_NUMERIC_SHAPE" | "CURRENCY_CODE_NUMERIC" | "CURRENCY_WORD_NUMERIC" | "CURRENCY_COLON_NUMERIC" | "CURRENCY_WITH_EXTRA_TEXT" | "NUMERIC_EXCESS_PRECISION" | "NUMERIC_TOO_LONG" | "NUMERIC_LIKE" | "LATIN_TEXT_WITH_DIGITS" | "CJK_ACCOUNTING_WITH_DIGITS" | "CJK_CURRENCY_WITH_DIGITS" | "CJK_ACCOUNTING_CURRENCY_WITH_DIGITS" | "CJK_OTHER_WITH_DIGITS" | "TEXT_WITH_DIGITS" | "TEXT" | "OTHER";

export function classifyPrivateCellShape(value: string): PrivateCellShape {
  const normalized = value.trim();
  if (!normalized) return "EMPTY";
  const hasCurrencyCode = /(?:CNY|RMB)/iu.test(normalized);
  const hasCurrencyWord = /(人民币|元|￥|¥)/u.test(normalized);
  let numeric = normalized.replace(/(?:CNY|RMB|人民币|[￥¥元])/giu, "").replace(/[，,\s]/gu, "");
  const hasCurrencyColon = hasCurrencyWord && /[:：]/u.test(numeric);
  if (hasCurrencyColon) numeric = numeric.replace(/[:：]/gu, "");
  const parenthesized = /^[（(].*[）)]$/u.test(numeric);
  numeric = numeric.replace(/^[（(]|[）)]$/gu, "");
  const numericMatch = numeric.match(/^([+-]?)(\d+)(?:\.(\d+))?$/u);
  if (numericMatch && (hasCurrencyCode || hasCurrencyWord || /^[\d.,+\-()（）￥¥元人民币\s]+$/u.test(normalized))) {
    if (numericMatch[2].length > 12) return "NUMERIC_TOO_LONG";
    if ((numericMatch[3]?.length ?? 0) > 2) return "NUMERIC_EXCESS_PRECISION";
    if (hasCurrencyCode) return "CURRENCY_CODE_NUMERIC";
    if (hasCurrencyColon) return "CURRENCY_COLON_NUMERIC";
    if (hasCurrencyWord) return "CURRENCY_WORD_NUMERIC";
    return "VALID_NUMERIC_SHAPE";
  }
  if (parenthesized && numericMatch) return "VALID_NUMERIC_SHAPE";
  if (/^[\d.,+\-()（）￥¥元人民币\s]+$/u.test(normalized)) return "NUMERIC_LIKE";
  const hasDigit = /\d/u.test(normalized);
  const hasCjk = /\p{Script=Han}/u.test(normalized);
  const hasLatin = /\p{Script=Latin}/u.test(normalized);
  const hasLetter = /\p{L}/u.test(normalized);
  const currencyRemainder = normalized
    .replace(/(?:CNY|RMB|人民币|[￥¥元])/giu, "")
    .replace(/[\d.,+\-()（）:：\s]/gu, "");
  if (hasDigit && hasCurrencyWord && currencyRemainder.length > 0) return "CURRENCY_WITH_EXTRA_TEXT";
  if (hasDigit && hasCjk) {
    const hasAccountingWord = /[收入支出借贷收付]/u.test(normalized);
    const hasCurrencyWord = /(人民币|元|￥|¥)/u.test(normalized);
    if (hasAccountingWord && hasCurrencyWord) return "CJK_ACCOUNTING_CURRENCY_WITH_DIGITS";
    if (hasAccountingWord) return "CJK_ACCOUNTING_WITH_DIGITS";
    if (hasCurrencyWord) return "CJK_CURRENCY_WITH_DIGITS";
    return "CJK_OTHER_WITH_DIGITS";
  }
  if (hasDigit && hasLatin) return "LATIN_TEXT_WITH_DIGITS";
  if (hasDigit && hasLetter) return "TEXT_WITH_DIGITS";
  if (hasLetter) return "TEXT";
  return "OTHER";
}

export function classifyFinanceSourceSheets(sheets: ReadonlyArray<{ name: string; matrix: string[][] }>): PrivateStagingKind {
  const candidates = new Set<(typeof STRUCTURED_KINDS)[number]>();
  for (const sheet of sheets) {
    for (const kind of STRUCTURED_KINDS) {
      const inspected = inspectFinanceHeader(kind, sheet.matrix);
      if (!inspected) continue;
      const missingRequired = kind === "EXTERNAL_THREE_STATEMENTS"
        ? inspected.missingFields.filter((field) => field !== "period")
        : inspected.missingFields;
      if (missingRequired.length === 0) candidates.add(kind);
    }
  }
  if (candidates.size === 0) return "UNCLASSIFIED";
  if (candidates.size > 1) return "MIXED";
  return [...candidates][0];
}

function safeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(normalized) ? normalized : ".unknown";
}

export function summarizePrivateStaging(entries: readonly PrivateStagingEntry[]): PrivateStagingSummary {
  const byExtension: Record<string, number> = {};
  const byKind: Record<PrivateStagingKind, number> = {
    BANK_STATEMENT: 0,
    PAYROLL: 0,
    ROSTER: 0,
    EXTERNAL_THREE_STATEMENTS: 0,
    OTHER: 0,
    MIXED: 0,
    UNCLASSIFIED: 0
  };
  const hashes = new Set<string>();
  let duplicateContentFiles = 0;
  let needsPreprocessing = 0;
  let unreadableFiles = 0;
  let unsupportedFiles = 0;

  for (const entry of entries) {
    const extension = safeExtension(entry.extension);
    byExtension[extension] = (byExtension[extension] ?? 0) + 1;
    byKind[entry.kind] += 1;
    if (entry.needsPreprocessing) needsPreprocessing += 1;
    if (entry.unreadable) unreadableFiles += 1;
    if (entry.unsupported) unsupportedFiles += 1;
    if (entry.sha256 && hashes.has(entry.sha256)) duplicateContentFiles += 1;
    if (entry.sha256) hashes.add(entry.sha256);
  }

  return {
    totalFiles: entries.length,
    duplicateContentFiles,
    needsPreprocessing,
    unreadableFiles,
    unsupportedFiles,
    byExtension: Object.fromEntries(Object.entries(byExtension).sort(([left], [right]) => left.localeCompare(right))),
    byKind
  };
}

export function summarizePrivateFinanceParses(entries: readonly PrivateFinanceParseEntry[]): PrivateFinanceParseSummary {
  const kinds: PrivateFinanceParseSummary["byKind"] = {
    BANK_STATEMENT: { files: 0, cleanFiles: 0, blockedFiles: 0, rowsInCleanFiles: 0, duplicateFiles: 0, parsedRows: 0, errorCount: 0, multiPeriodFiles: 0, errorCodes: {}, errorFields: {}, errorShapes: {}, byPeriod: {} },
    PAYROLL: { files: 0, cleanFiles: 0, blockedFiles: 0, rowsInCleanFiles: 0, duplicateFiles: 0, parsedRows: 0, errorCount: 0, multiPeriodFiles: 0, errorCodes: {}, errorFields: {}, errorShapes: {}, byPeriod: {} },
    ROSTER: { files: 0, cleanFiles: 0, blockedFiles: 0, rowsInCleanFiles: 0, duplicateFiles: 0, parsedRows: 0, errorCount: 0, multiPeriodFiles: 0, errorCodes: {}, errorFields: {}, errorShapes: {}, byPeriod: {} },
    EXTERNAL_THREE_STATEMENTS: { files: 0, cleanFiles: 0, blockedFiles: 0, rowsInCleanFiles: 0, duplicateFiles: 0, parsedRows: 0, errorCount: 0, multiPeriodFiles: 0, errorCodes: {}, errorFields: {}, errorShapes: {}, byPeriod: {} }
  };
  const seen = new Set<string>();

  for (const entry of entries) {
    const summary = kinds[entry.kind];
    summary.files += 1;
    if (entry.errorCodes.length === 0 && entry.rowCount > 0) {
      summary.cleanFiles += 1;
      summary.rowsInCleanFiles += entry.rowCount;
    } else {
      summary.blockedFiles += 1;
    }
    const duplicateKey = `${entry.kind}:${entry.sha256}`;
    if (entry.sha256 && seen.has(duplicateKey)) summary.duplicateFiles += 1;
    if (entry.sha256) seen.add(duplicateKey);
    summary.parsedRows += entry.rowCount;
    summary.errorCount += entry.errorCodes.length;
    if (new Set(entry.periods).size > 1) summary.multiPeriodFiles += 1;
    for (const code of entry.errorCodes) summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
    for (const field of entry.errorFields) summary.errorFields[field] = (summary.errorFields[field] ?? 0) + 1;
    for (const shape of entry.errorShapes) summary.errorShapes[shape] = (summary.errorShapes[shape] ?? 0) + 1;
    for (const period of new Set(entry.periods)) summary.byPeriod[period] = (summary.byPeriod[period] ?? 0) + 1;
  }

  for (const summary of Object.values(kinds)) {
    summary.errorCodes = Object.fromEntries(Object.entries(summary.errorCodes).sort(([left], [right]) => left.localeCompare(right)));
    summary.errorFields = Object.fromEntries(Object.entries(summary.errorFields).sort(([left], [right]) => left.localeCompare(right)));
    summary.errorShapes = Object.fromEntries(Object.entries(summary.errorShapes).sort(([left], [right]) => left.localeCompare(right)));
    summary.byPeriod = Object.fromEntries(Object.entries(summary.byPeriod).sort(([left], [right]) => left.localeCompare(right)));
  }
  return { byKind: kinds };
}
