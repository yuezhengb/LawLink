import { describe, expect, it } from "vitest";
import { parseFinancePdfTables } from "@/lib/finance/pdf-table-parser";

describe("数字 PDF 与 OCR 候选", () => {
  it("按页码和表号把数字 PDF 表格保留为可映射来源", () => {
    const parsed = parseFinancePdfTables({
      version: 1,
      pages: [{ pageNumber: 2, extraction: "TEXT_TABLE", tables: [[["期间", "项目", "金额"], ["2026-08", "合成科目", "100.00"]]], ocrWords: [] }]
    });

    expect(parsed.sheets[0]).toMatchObject({ name: "PDF第2页-表1", rows: [["期间", "项目", "金额"], ["2026-08", "合成科目", "100.00"]] });
    expect(parsed.ocrCandidates).toEqual([]);
  });

  it("OCR 无法形成稳定表格时只返回带页码、坐标和置信度的人工候选", () => {
    const parsed = parseFinancePdfTables({
      version: 1,
      pages: [{ pageNumber: 1, extraction: "OCR_CANDIDATE", tables: [], ocrWords: [{ text: "2026-08-01", confidence: 76, bbox: [10, 20, 80, 30] }] }]
    });

    expect(parsed.sheets).toEqual([]);
    expect(parsed.ocrCandidates).toEqual([{ pageNumber: 1, extraction: "OCR_CANDIDATE", words: [{ text: "2026-08-01", confidence: 76, bbox: [10, 20, 80, 30] }] }]);
    expect(parsed.canCommitStructuredRows).toBe(false);
  });
});
