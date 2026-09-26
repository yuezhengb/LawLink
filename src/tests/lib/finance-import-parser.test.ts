import ExcelJS from "exceljs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  normalizeFinanceRow,
  parseFinanceWorkbook,
  readFinanceMatrix,
  readFinanceWorkbookSheets,
  validateFinanceWorkbookMatrixDimensions
} from "@/lib/finance/import-parser";
import { parseFinanceSource } from "@/lib/finance/finance-source-parser";

async function xlsxBuffer(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function multiSheetXlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("银行A");
  first.addRow(["日期", "对方户名", "贷方发生额"]);
  first.addRow(["2026-08-01", "合成客户甲", "100.00"]);
  const second = workbook.addWorksheet("银行B");
  second.addRow(["日期", "对方户名", "贷方发生额"]);
  second.addRow(["2026-08-02", "合成客户乙", "200.00"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function wideFormattedXlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["日期", "金额"]);
  sheet.addRow(["2026-08-01", "100.00"]);
  // Some source workbooks have formatting thousands of columns to the right
  // without any data. The parser must not scan that empty formatted tail.
  sheet.getCell(1, 16373).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function oversizedZipEntryBuffer(uncompressedSize: number): Buffer {
  const fileName = Buffer.from("content.xml");
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(1, 20);
  entry.writeUInt32LE(uncompressedSize, 24);
  entry.writeUInt16LE(fileName.length, 28);
  const centralDirectory = Buffer.concat([entry, fileName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  return Buffer.concat([centralDirectory, end]);
}

function zipEntryExceedingDeclaredSizeBuffer(): Buffer {
  const fileName = Buffer.from("content.xml");
  const uncompressed = Buffer.alloc(1024, 65);
  const compressed = deflateRawSync(uncompressed);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.byteLength, 18);
  localHeader.writeUInt32LE(4, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  const localEntry = Buffer.concat([localHeader, fileName, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.byteLength, 20);
  centralHeader.writeUInt32LE(4, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  const centralDirectory = Buffer.concat([centralHeader, fileName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralDirectory, end]);
}

describe("财务来源文件解析", () => {
  it("忽略仅有格式的超宽空尾列", async () => {
    const result = await readFinanceMatrix(await wideFormattedXlsxBuffer(), "工资表.xlsx");

    expect(result.errors).toEqual([]);
    expect(result.matrix[0]).toEqual(["日期", "金额"]);
    expect(result.matrix[1]).toEqual(["2026-08-01", "100.00"]);
  });

  it("在展开压缩内容前拒绝超出大小上限的工作簿", async () => {
    const result = await readFinanceWorkbookSheets(
      oversizedZipEntryBuffer(64 * 1024 * 1024 + 1),
      "oversized.xlsx"
    );

    expect(result.errors).toMatchObject([
      expect.objectContaining({ code: "PARSE_FAILURE", message: expect.stringContaining("安全解析限制") })
    ]);
  });

  it("按实际解压大小拒绝伪报尺寸的压缩工作簿", async () => {
    const result = await readFinanceWorkbookSheets(zipEntryExceedingDeclaredSizeBuffer(), "mismatched.xlsx");

    expect(result.errors).toMatchObject([
      expect.objectContaining({ code: "PARSE_FAILURE", message: expect.stringContaining("安全解析限制") })
    ]);
  });

  it("拒绝超过安全稠密矩阵范围的稀疏工作表", () => {
    expect(() => validateFinanceWorkbookMatrixDimensions(1_048_576, 16_384, 0)).toThrow("工作簿超出安全解析限制");
    expect(() => validateFinanceWorkbookMatrixDimensions(500, 500, 900_000)).toThrow("工作簿超出安全解析限制");
  });

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
      "BANK_STATEMENT"
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

  it("解析所有银行工作表并保留各表内真实行号", async () => {
    const result = await parseFinanceWorkbook(await multiSheetXlsxBuffer(), "synthetic-bank.xlsx", "BANK_STATEMENT");

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => [row.sourceSheet, row.sourceRowNumber])).toEqual([["银行A", 2], ["银行B", 2]]);
  });

  it("使用逐工作表列索引映射识别非标准银行表头", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("账户流水");
    sheet.addRow(["记账日", "流入金额", "付款方名称", "用途说明"]);
    sheet.addRow(["2026-08-03", "250.00", "合成往来方", "合成用途"]);

    const result = await parseFinanceWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      "synthetic-bank.xlsx",
      "BANK_STATEMENT",
      undefined,
      { "账户流水": { occurredAt: 0, amount: 1, counterparty: 2, description: 3 } }
    );

    expect(result.rows).toMatchObject([{
      sourceSheet: "账户流水",
      sourceRowNumber: 2,
      occurredAt: "2026-08-03",
      amount: "250.00",
      counterparty: "合成往来方",
      description: "合成用途"
    }]);
    expect(result.errors).toEqual([]);
  });

  it("借贷金额列已明确方向时忽略冗余金额说明列的非金额文本", () => {
    const result = normalizeFinanceRow(
      { 日期: "2026-08-01", 金额: "文本说明", 借方发生额: "", 贷方发生额: "100.00" },
      { occurredAt: "日期", amount: "金额", debit: "借方发生额", credit: "贷方发生额" },
      { sourceKind: "BANK_STATEMENT", sourceRowNumber: 2 }
    );

    expect(result).toMatchObject({ occurredAt: "2026-08-01", amount: "100.00", direction: "CREDIT" });
    expect(result).not.toHaveProperty("code");
  });

  it("工资资料按工资字段解析，不伪造银行交易日期和方向", async () => {
    const result = await parseFinanceSource(
      Buffer.from("月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员甲,15000.00,12000.00,800.00", "utf8"),
      "synthetic-payroll.csv",
      "PAYROLL"
    );

    expect(result).toMatchObject({
      kind: "PAYROLL",
      period: "2026-08",
      rows: [{ sourceRowNumber: 2, displayName: "合成人员甲", declaredSalary: "15000.00", actualCashPaid: "12000.00", selfCostDue: "800.00" }],
      errors: []
    });
  });

  it("解析薪资工作簿所有工作表并保留表名", async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet("律师");
    first.addRow(["月份", "姓名", "申报工资", "实际支付", "自担社保"]);
    first.addRow(["2026-08", "合成人员甲", "15000", "12000", "800"]);
    const second = workbook.addWorksheet("行政");
    second.addRow(["月份", "姓名", "申报工资", "实际支付", "自担社保"]);
    second.addRow(["2026-08", "合成人员乙", "10000", "9500", "0"]);

    const result = await parseFinanceSource(Buffer.from(await workbook.xlsx.writeBuffer()), "synthetic-payroll.xlsx", "PAYROLL");

    expect(result.kind).toBe("PAYROLL");
    expect(result.rows.map((row) => [row.sourceSheet, row.sourceRowNumber])).toEqual([["律师", 2], ["行政", 2]]);
  });

  it("花名册没有日期金额列时仍能解析，并要求显式截至日期", async () => {
    const result = await parseFinanceSource(
      Buffer.from("姓名,身份,在册期间\n合成人员甲,律师,在册", "utf8"),
      "synthetic-roster.csv",
      "ROSTER",
      { asOfDay: "2026-08-31" }
    );

    expect(result).toMatchObject({
      kind: "ROSTER",
      asOfDay: "2026-08-31",
      rows: [{ sourceRowNumber: 2, displayName: "合成人员甲", roleLabel: "律师" }],
      errors: []
    });
  });

  it("识别律所花名册中的律所职位列", async () => {
    const result = await parseFinanceSource(
      Buffer.from("姓名,律所职位\n合成人员乙,律师", "utf8"),
      "synthetic-roster-position.csv",
      "ROSTER",
      { asOfDay: "2026-08-31" }
    );

    expect(result).toMatchObject({
      kind: "ROSTER",
      rows: [{ displayName: "合成人员乙", roleLabel: "律师" }],
      errors: []
    });
  });

  it("外部三表解析为报表核对行，不要求银行方向", async () => {
    const result = await parseFinanceSource(
      Buffer.from("期间,报表,项目,期末金额\n2026-08,资产负债表,货币资金,100000.00", "utf8"),
      "synthetic-external.csv",
      "EXTERNAL_THREE_STATEMENTS"
    );

    expect(result).toMatchObject({
      kind: "EXTERNAL_THREE_STATEMENTS",
      period: "2026-08",
      rows: [{ sourceRowNumber: 2, statement: "BALANCE_SHEET", item: "货币资金", amount: "100000.00" }],
      errors: []
    });
  });

  it("工资文件缺少必需字段时报告行号和错误，不生成银行流水", async () => {
    const result = await parseFinanceSource(
      Buffer.from("月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员甲,不是金额,0,0", "utf8"),
      "synthetic-payroll.csv",
      "PAYROLL"
    );

    expect(result.kind).toBe("PAYROLL");
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({ rowNumber: 2, code: "INVALID_AMOUNT" });
  });

  it("工资表可按工作表列索引手工映射非标准字段名", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("人员薪资");
    sheet.addRow(["人员编号", "工资基数", "到账数", "个人成本"]);
    sheet.addRow(["SYN-01", "15000", "12000", "800"]);

    const result = await parseFinanceSource(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      "synthetic-payroll.xlsx",
      "PAYROLL",
      {
        period: "2026-08",
        columnMappingsBySheet: { "人员薪资": { name: 0, salary: 1, actual: 2, selfCost: 3 } }
      }
    );

    expect(result).toMatchObject({
      kind: "PAYROLL",
      rows: [{ sourceSheet: "人员薪资", sourceRowNumber: 2, displayName: "SYN-01", declaredSalary: "15000.00", actualCashPaid: "12000.00", selfCostDue: "800.00" }],
      errors: []
    });
  });

  it("传统 XLS 返回明确的转换提示，不调用不受信任的转换器", async () => {
    const result = await parseFinanceWorkbook(Buffer.from("not-a-workbook"), "流水.xls", "BANK_STATEMENT");

    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({ code: "UNSUPPORTED_LEGACY_XLS", rowNumber: 0 });
    expect(result.errors[0].message).toContain("XLSX");
  });

  it("XLSM 来源档案统计全部工作表且不伪造成财务事实", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("合成一").addRows([["编号", "说明"], ["A-1", "记录一"], ["A-2", "记录二"]]);
    workbook.addWorksheet("合成二").addRows([["编号", "说明"], ["B-1", "记录三"]]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const sheets = await readFinanceWorkbookSheets(bytes, "private-source.xlsm");
    const parsed = await parseFinanceSource(bytes, "private-source.xlsm", "OTHER");

    expect(sheets.errors).toEqual([]);
    expect(sheets.sheets).toHaveLength(2);
    expect(parsed.errors).toEqual([]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.rows).toEqual([]);
    expect(parsed.reviewWarnings).toContain("其他资料仅归档原始文件，不会进入银行对账或财务计算。");
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
