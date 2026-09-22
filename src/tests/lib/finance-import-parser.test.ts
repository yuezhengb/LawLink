import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  normalizeFinanceRow,
  parseFinanceWorkbook
} from "@/lib/finance/import-parser";

async function xlsxBuffer(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("财务来源文件解析", () => {
  it("识别借方/贷方并统一为有符号金额", async () => {
    const result = await parseFinanceWorkbook(
      await xlsxBuffer([
        ["日期", "对方户名", "借方发生额", "贷方发生额", "余额"],
        ["2026-08-01", "合成客户", "", "100000.00", "100000.00"]
      ]),
      "银行流水.xlsx",
      "BANK_STATEMENT"
    );

    expect(result.rows[0]).toMatchObject({
      occurredAt: "2026-08-01",
      amount: "100000.00",
      direction: "CREDIT",
      counterparty: "合成客户",
      balance: "100000.00"
    });
    expect(result.errors).toEqual([]);
  });

  it("识别借方支出并保留负号", async () => {
    const result = await parseFinanceWorkbook(
      await xlsxBuffer([
        ["交易日期", "摘要", "支出"],
        ["2026/08/02", "办公室租金", "1,200.50"]
      ]),
      "费用.xlsx",
      "OTHER"
    );

    expect(result.rows[0]).toMatchObject({
      occurredAt: "2026-08-02",
      amount: "-1200.50",
      direction: "DEBIT",
      description: "办公室租金"
    });
  });

  it("支持带引号和 BOM 的 CSV", async () => {
    const csv = Buffer.from(
      "\uFEFF日期,对方名称,金额,摘要\r\n2026-08-03,\"合成,客户\",(80.00),\"退款\"\r\n",
      "utf8"
    );
    const result = await parseFinanceWorkbook(csv, "退款.csv", "BANK_STATEMENT");

    expect(result.rows[0]).toMatchObject({
      occurredAt: "2026-08-03",
      amount: "-80.00",
      direction: "DEBIT",
      counterparty: "合成,客户",
      description: "退款"
    });
  });

  it("缺少日期或金额时返回行级错误而不是静默丢弃", async () => {
    const result = await parseFinanceWorkbook(
      await xlsxBuffer([
        ["摘要", "金额"],
        ["缺日期", "100.00"]
      ]),
      "bad.xlsx",
      "BANK_STATEMENT"
    );

    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "MISSING_OCCURRED_AT",
      rowNumber: 2
    });
    expect(result.totalRows).toBe(1);
  });

  it("传统 XLS 返回明确的转换提示，不调用不受信任的转换器", async () => {
    const result = await parseFinanceWorkbook(Buffer.from("not-a-workbook"), "流水.xls", "BANK_STATEMENT");

    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({ code: "UNSUPPORTED_LEGACY_XLS", rowNumber: 0 });
    expect(result.errors[0].message).toContain("XLSX");
  });

  it("手工映射仍然经过同一套金额和日期规范化", () => {
    const result = normalizeFinanceRow(
      {
        dateColumn: "2026-08-04",
        creditColumn: "2,000",
        partyColumn: "合成客户"
      },
      {
        occurredAt: "dateColumn",
        credit: "creditColumn",
        counterparty: "partyColumn"
      },
      { sourceKind: "BANK_STATEMENT", sourceRowNumber: 7 }
    );

    expect(result).toMatchObject({
      sourceRowNumber: 7,
      occurredAt: "2026-08-04",
      amount: "2000.00",
      direction: "CREDIT"
    });
  });
});
