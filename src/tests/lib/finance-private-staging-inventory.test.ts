import { describe, expect, it } from "vitest";
import {
  classifyFinanceSourceSheets,
  classifyPrivateCellShape,
  summarizePrivateFinanceParses,
  summarizePrivateStaging
} from "@/lib/finance/private-staging-inventory";

describe("private finance staging inventory", () => {
  it("classifies a source only when its required finance headers are present", () => {
    expect(classifyFinanceSourceSheets([
      { name: "private-sheet-name", matrix: [["交易日期", "对方户名", "收入", "支出"]] }
    ])).toBe("BANK_STATEMENT");
    expect(classifyFinanceSourceSheets([
      { name: "another-private-sheet", matrix: [["姓名", "岗位"]] }
    ])).toBe("ROSTER");
    expect(classifyFinanceSourceSheets([
      { name: "unknown", matrix: [["列A", "列B"]] }
    ])).toBe("UNCLASSIFIED");
  });

  it("returns aggregate-only counts without hashes, names, or source values", () => {
    const summary = summarizePrivateStaging([
      { extension: ".xlsx", sha256: "private-hash-a", kind: "BANK_STATEMENT", needsPreprocessing: false, unreadable: false, unsupported: false },
      { extension: ".bin", sha256: "private-hash-a", kind: "BANK_STATEMENT", needsPreprocessing: false, unreadable: false, unsupported: false },
      { extension: ".pdf", sha256: "private-hash-b", kind: "UNCLASSIFIED", needsPreprocessing: true, unreadable: false, unsupported: false },
      { extension: ".csv", sha256: "private-hash-c", kind: "UNCLASSIFIED", needsPreprocessing: false, unreadable: true, unsupported: false }
    ]);

    expect(summary).toEqual({
      totalFiles: 4,
      duplicateContentFiles: 1,
      needsPreprocessing: 1,
      unreadableFiles: 1,
      unsupportedFiles: 0,
      byExtension: { ".bin": 1, ".csv": 1, ".pdf": 1, ".xlsx": 1 },
      byKind: { BANK_STATEMENT: 2, PAYROLL: 0, ROSTER: 0, EXTERNAL_THREE_STATEMENTS: 0, OTHER: 0, MIXED: 0, UNCLASSIFIED: 2 }
    });
    expect(JSON.stringify(summary)).not.toContain("private-hash");
  });

  it("marks a workbook with different finance kinds as mixed rather than guessing", () => {
    expect(classifyFinanceSourceSheets([
      { name: "sheet-one", matrix: [["姓名", "申报工资", "实际支付", "自担社保"]] },
      { name: "sheet-two", matrix: [["姓名", "岗位"]] }
    ])).toBe("MIXED");
  });

  it("summarizes parse outcomes by kind and period without retaining source fingerprints", () => {
    const summary = summarizePrivateFinanceParses([
      { kind: "PAYROLL", sha256: "private-payroll-hash", rowCount: 12, errorCodes: [], errorFields: [], errorShapes: [], periods: ["2026-08"] },
      { kind: "PAYROLL", sha256: "private-payroll-hash", rowCount: 12, errorCodes: ["INVALID_AMOUNT"], errorFields: ["actual"], errorShapes: ["actual:TEXT_WITH_DIGITS"], periods: ["2026-08"] },
      { kind: "BANK_STATEMENT", sha256: "private-bank-hash", rowCount: 4, errorCodes: ["INVALID_AMOUNT", "MISSING_OCCURRED_AT"], errorFields: ["amount", "occurredAt"], errorShapes: ["amount:NUMERIC_LIKE"], periods: ["2026-07", "2026-08"] }
    ]);

    expect(summary.byKind.PAYROLL).toMatchObject({ files: 2, cleanFiles: 1, blockedFiles: 1, rowsInCleanFiles: 12, duplicateFiles: 1, parsedRows: 24, errorCount: 1, errorFields: { actual: 1 }, errorShapes: { "actual:TEXT_WITH_DIGITS": 1 }, byPeriod: { "2026-08": 2 } });
    expect(summary.byKind.BANK_STATEMENT).toMatchObject({ files: 1, cleanFiles: 0, blockedFiles: 1, rowsInCleanFiles: 0, parsedRows: 4, errorCount: 2, multiPeriodFiles: 1, errorFields: { amount: 1, occurredAt: 1 }, errorShapes: { "amount:NUMERIC_LIKE": 1 }, byPeriod: { "2026-07": 1, "2026-08": 1 } });
    expect(JSON.stringify(summary)).not.toContain("private-");
  });

  it("reduces invalid cell contents to non-reversible shape labels", () => {
    expect(classifyPrivateCellShape("1,234.50")).toBe("VALID_NUMERIC_SHAPE");
    expect(classifyPrivateCellShape("CNY 1,234.50")).toBe("CURRENCY_CODE_NUMERIC");
    expect(classifyPrivateCellShape("人民币：1,234.50")).toBe("CURRENCY_COLON_NUMERIC");
    expect(classifyPrivateCellShape("人民币附加说明123.00")).toBe("CURRENCY_WITH_EXTRA_TEXT");
    expect(classifyPrivateCellShape("1,234.567")).toBe("NUMERIC_EXCESS_PRECISION");
    expect(classifyPrivateCellShape("2026年8月")).toBe("CJK_OTHER_WITH_DIGITS");
    expect(classifyPrivateCellShape("支出100.00")).toBe("CJK_ACCOUNTING_WITH_DIGITS");
    expect(classifyPrivateCellShape("合成人员")).toBe("TEXT");
    expect(classifyPrivateCellShape("")).toBe("EMPTY");
  });
});
