export type FinancePdfExtraction = "TEXT_TABLE" | "TEXT_CANDIDATE" | "OCR_TABLE" | "OCR_CANDIDATE";

export type FinancePdfWord = {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
};

export type FinancePdfPage = {
  pageNumber: number;
  extraction: FinancePdfExtraction;
  tables: string[][][];
  ocrWords: FinancePdfWord[];
};

export type FinancePdfPreprocessResult = {
  version: 1;
  pages: FinancePdfPage[];
};

export type FinancePdfTableSheet = {
  name: string;
  pageNumber: number;
  tableNumber: number;
  extraction: "TEXT_TABLE" | "OCR_TABLE";
  rows: string[][];
};

export function parseFinancePdfTables(input: FinancePdfPreprocessResult): {
  sheets: FinancePdfTableSheet[];
  ocrCandidates: Array<{ pageNumber: number; extraction: "TEXT_CANDIDATE" | "OCR_CANDIDATE"; words: FinancePdfWord[] }>;
  canCommitStructuredRows: boolean;
} {
  const sheets: FinancePdfTableSheet[] = [];
  const ocrCandidates: Array<{ pageNumber: number; extraction: "TEXT_CANDIDATE" | "OCR_CANDIDATE"; words: FinancePdfWord[] }> = [];
  for (const page of input.pages) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) continue;
    page.tables.forEach((rows, index) => {
      if (!rows.length || !rows.some((row) => row.some((cell) => cell.trim()))) return;
      if (page.extraction === "OCR_CANDIDATE" || page.extraction === "TEXT_CANDIDATE") return;
      sheets.push({
        name: `PDF第${page.pageNumber}页-表${index + 1}`,
        pageNumber: page.pageNumber,
        tableNumber: index + 1,
        extraction: page.extraction,
        rows: rows.map((row) => row.map((cell) => String(cell ?? "")))
      });
    });
    if (page.extraction === "TEXT_CANDIDATE" || page.extraction === "OCR_CANDIDATE" || (page.extraction === "OCR_TABLE" && page.tables.length === 0)) {
      ocrCandidates.push({ pageNumber: page.pageNumber, extraction: page.extraction === "TEXT_CANDIDATE" ? "TEXT_CANDIDATE" : "OCR_CANDIDATE", words: page.ocrWords });
    }
  }
  return { sheets, ocrCandidates, canCommitStructuredRows: sheets.length > 0 && ocrCandidates.length === 0 };
}
