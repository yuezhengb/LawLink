import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildCloseWorkbook, type CloseWorkbookKind } from "@/server/finance/internal-export";

const actor = { id: "synthetic-finance-user", role: "FINANCE" } as const;

function syntheticDb() {
  const periodStart = new Date("2026-08-01T00:00:00+08:00");
  const periodEnd = new Date("2026-09-01T00:00:00+08:00");
  const run = { id: "synthetic-run", status: "COMMITTED", periodStart, periodEnd, sourceHash: "synthetic-source-hash", allocationLines: [] };
  return {
    financeCalculationRun: { findUnique: vi.fn().mockResolvedValue(run), findMany: vi.fn().mockResolvedValue([run]) },
    financeFirmPeriodSnapshot: { findUnique: vi.fn().mockResolvedValue({
      operatingResult: new Prisma.Decimal("1000.00"), firmSalaryCost: new Prisma.Decimal("500.00"), firmSocialCost: new Prisma.Decimal("100.00"), firmFundCost: new Prisma.Decimal("50.00"), rentCost: new Prisma.Decimal("200.00"), officeCost: new Prisma.Decimal("80.00"), turnoverTaxCost: new Prisma.Decimal("20.00"), otherCost: new Prisma.Decimal("30.00")
    }) },
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([{
      userId: "synthetic-user-1", user: { id: "synthetic-user-1", name: "合成人员" }, grossSalary: "15000.00", actualCashPaid: "0.00", isDeemedWage: true,
      selfCostDue: "800.00", firmSalaryCost: "500.00", firmSocialCost: "100.00", firmFundCost: "50.00", treatmentReviewed: true, treatmentNote: "合成口径"
    }]) },
    financeImportRecord: { findMany: vi.fn().mockResolvedValue([{ statement: "BALANCE_SHEET", item: "货币资金", amount: "100000.00", reviewStatus: "NEEDS_REVIEW" }]) },
    financePersonPeriodSnapshot: { findMany: vi.fn().mockResolvedValue([{
      userId: "synthetic-user-1", user: { name: "合成人员" }, openingDistributable: "100.00", openingReserve: "200.00", earned: "3000.00", selfCostDue: "800.00",
      selfFundingIn: "1000.00", selfFundingUsed: "200.00", selfCostChargedToIncome: "600.00", withdrawn: "100.00", partnerTaxAdvance: "50.00",
      distributableEnd: "2350.00", reserveEnd: "1000.00", reserveGap: "0.00"
    }]) },
    financeAdjustment: { findMany: vi.fn().mockResolvedValue([{
      id: "synthetic-adjustment", account: "user.self_cost", targetUserId: "synthetic-user-1", amount: "25.00", status: "REVERSED",
      reversalOfId: "synthetic-original-adjustment", reason: "合成冲销记录", createdAt: new Date("2026-08-25T00:00:00+08:00")
    }]) }
  };
}

async function workbookFor(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook;
}

describe("月结独立工作簿", () => {
  it("四类工作簿各自呈现对应正式事实，并共用runId与来源指纹", async () => {
    const db = syntheticDb();
    const built = await Promise.all(([
      "WAGE", "ACCOUNTANT", "PERSONAL", "ADJUSTMENT_AUDIT"
    ] as CloseWorkbookKind[]).map((kind) => buildCloseWorkbook(kind, "synthetic-run", { db: db as never, actor })));
    const workbooks = await Promise.all(built.map(workbookFor));
    const sheetNames = workbooks.map((workbook) => workbook.worksheets.map((sheet) => sheet.name));

    expect(sheetNames[0]).toContain("工资与实付核对");
    expect(sheetNames[1]).toEqual(expect.arrayContaining(["内部经营核对", "外部三表核对", "案件金额核对", "本期案件收款分配"]));
    expect(sheetNames[2]).toContain("个人双余额快照");
    expect(sheetNames[3]).toContain("调整与冲销审计");
    for (const workbook of workbooks) {
      const firstRow = workbook.worksheets[0].getRow(1).values;
      expect(firstRow).toContain("synthetic-run");
      expect(firstRow).toContain("synthetic-source-hash");
    }
    expect(workbooks[0].worksheets[0].getRow(3).values).toContain(15000);
    expect(workbooks[0].worksheets[0].getRow(3).values).toContain(0);
    expect(workbooks[1].worksheets[1].getRow(3).values).toContain("货币资金");
    expect(workbooks[2].worksheets[0].getRow(3).values).toContain(2350);
    expect(workbooks[3].worksheets[0].getRow(3).values).toContain("合成冲销记录");
    expect(new Set(built.map((bytes) => createHash("sha256").update(bytes).digest("hex"))).size).toBe(4);
  });

  it("拒绝导出未提交或不存在的正式批次", async () => {
    const db = syntheticDb();
    db.financeCalculationRun.findUnique.mockResolvedValue({ id: "synthetic-run", status: "PREVIEW", periodStart: new Date(), periodEnd: new Date(), sourceHash: "hash" });
    await expect(buildCloseWorkbook("WAGE", "synthetic-run", { db: db as never, actor })).rejects.toThrow("正式财务批次不存在或未提交");
  });
});
