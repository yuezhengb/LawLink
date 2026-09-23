import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildFinanceWorkbook } from "@/server/finance/internal-export";
import { getInternalFinanceSummary, type FinanceReportsDependencies } from "@/server/finance/internal-reports";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;
const start = new Date("2026-08-01T00:00:00+08:00");
const end = new Date("2026-09-01T00:00:00+08:00");

function committedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-committed",
    periodStart: start,
    periodEnd: end,
    sourceHash: "hash-committed",
    status: "COMMITTED",
    calculatedAt: new Date("2026-09-01T01:00:00Z"),
    allocationLines: [
      {
        id: "line-1",
        paymentId: "synthetic-payment-1",
        matterId: "synthetic-matter-1",
        targetUserId: "synthetic-user-1",
        ruleVersionId: "rule-version-1",
        grossAmount: new Prisma.Decimal("100.00"),
        channelAmount: new Prisma.Decimal("10.00"),
        firmAmount: new Prisma.Decimal("40.50"),
        sourceAmount: new Prisma.Decimal("9.90"),
        handlingAmount: new Prisma.Decimal("22.28"),
        coAmount: new Prisma.Decimal("17.32"),
        matter: { internalCode: "SYN-2026-001", title: "合成案件", claimAmount: new Prisma.Decimal("350000.00"), primaryClient: { id: "synthetic-client-1", name: "合成客户" } },
        targetUser: { id: "synthetic-user-1", name: "合成人员一" },
        payment: { occurredAt: new Date("2026-08-01T00:00:00+08:00") }
      }
    ],
    ...overrides
  };
}

function mockDeps() {
  const db = {
    financeCalculationRun: { findMany: vi.fn() },
    financeFirmPeriodSnapshot: { findUnique: vi.fn().mockResolvedValue(null) },
    billing: { findMany: vi.fn().mockResolvedValue([]) },
    invoiceRequest: { findMany: vi.fn().mockResolvedValue([]) },
    invoiceAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
    payment: { findMany: vi.fn().mockResolvedValue([]) }
  };
  return { db, deps: { db: db as never, actor } satisfies FinanceReportsDependencies };
}

describe("内部财务三视角报表", () => {
  it("只汇总 COMMITTED 计算批次", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([
      committedRun(),
      committedRun({ id: "run-preview", status: "PREVIEW", sourceHash: "hash-preview", allocationLines: [{ ...committedRun().allocationLines[0], grossAmount: new Prisma.Decimal("999.00") }] })
    ]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "LAWYER" }, deps);

    expect(result.total).toBe("100.00");
    expect(result.calculationRunId).toBe("run-committed");
  });

  it("三视角使用同一计算批次并可穿透到分配行", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps);

    expect(result.persons[0].calculationRunId).toBe(result.firm.calculationRunId);
    expect(result.projects[0].lines[0].sourcePaymentId).toBe("synthetic-payment-1");
  });

  it("多人角色分配按受益明细汇总个人所得，项目收入仍只记一次", async () => {
    const { db, deps } = mockDeps();
    const line = committedRun().allocationLines[0];
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun({
      allocationLines: [{
        ...line,
        recipients: [
          { userId: "synthetic-user-1", role: "SOURCE", shareRate: new Prisma.Decimal("1"), amount: new Prisma.Decimal("9.90"), user: { name: "合成人员一" } },
          { userId: "synthetic-user-1", role: "HANDLING", shareRate: new Prisma.Decimal("0.555021"), amount: new Prisma.Decimal("12.38"), user: { name: "合成人员一" } },
          { userId: "synthetic-user-2", role: "HANDLING", shareRate: new Prisma.Decimal("0.444979"), amount: new Prisma.Decimal("9.90"), user: { name: "合成人员二" } },
          { userId: "synthetic-user-2", role: "CO", shareRate: new Prisma.Decimal("1"), amount: new Prisma.Decimal("17.32"), user: { name: "合成人员二" } }
        ]
      }]
    })]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps);

    expect(result.persons).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "synthetic-user-1", grossIncome: "22.28", sourceAmount: "9.90", handlingAmount: "12.38", coAmount: "0.00" }),
      expect.objectContaining({ userId: "synthetic-user-2", grossIncome: "27.22", sourceAmount: "0.00", handlingAmount: "9.90", coAmount: "17.32" })
    ]));
    expect(result.total).toBe("100.00");
    expect(result.projects[0].lines).toHaveLength(1);
  });

  it("项目视图分开显示标的额、有效签约律师费、累计开票净额和确认净收款", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);
    db.billing.findMany.mockResolvedValue([
      { id: "billing-base", matterId: "synthetic-matter-1", sourceBillingId: null, signedAt: start, status: "ACTIVE", contractAmount: new Prisma.Decimal("100000.00"), resultingAmount: new Prisma.Decimal("120000.00") },
      { id: "billing-amendment", matterId: "synthetic-matter-1", sourceBillingId: "billing-base", signedAt: start, status: "ACTIVE", contractAmount: new Prisma.Decimal("20000.00"), resultingAmount: new Prisma.Decimal("120000.00") }
    ]);
    db.invoiceRequest.findMany.mockResolvedValue([
      { id: "invoice-1", matterId: "synthetic-matter-1", amount: new Prisma.Decimal("30000.00") },
      { id: "invoice-2", matterId: "synthetic-matter-1", amount: new Prisma.Decimal("8000.00") }
    ]);
    db.invoiceAdjustment.findMany.mockResolvedValue([{ invoiceId: "invoice-1", amount: new Prisma.Decimal("2000.00") }]);
    db.payment.findMany.mockResolvedValue([
      { id: "payment-1", matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("50000.00"), refundedAmount: new Prisma.Decimal("5000.00"), sourceEntry: { matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("50000.00"), confirmState: "CONFIRMED" } },
      { id: "payment-2", matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("40000.00"), refundedAmount: new Prisma.Decimal("0.00"), sourceEntry: { matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("40000.00"), confirmState: "CONFIRMED" } }
    ]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps);

    expect(result.projects[0]).toMatchObject({
      claimAmount: "350000.00",
      signedContractAmount: "120000.00",
      issuedInvoiceNetAmount: "36000.00",
      confirmedNetReceiptAmount: "85000.00",
      periodAllocationAmount: "100.00"
    });
    expect(db.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ matterId: { in: ["synthetic-matter-1"] }, moneyKind: "LAWYER_FEE" })
    }));
  });

  it("项目收款来源与确认流水金额不一致时拒绝给出误导性汇总", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);
    db.payment.findMany.mockResolvedValue([{
      id: "payment-bad", matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("50000.00"), refundedAmount: new Prisma.Decimal("0.00"),
      sourceEntry: { matterId: "synthetic-matter-1", moneyKind: "LAWYER_FEE", amount: new Prisma.Decimal("49000.00"), confirmState: "CONFIRMED" }
    }]);

    await expect(getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps)).rejects.toThrow("实收来源不一致");
  });

  it("律所经营报表读取正式快照中的真实成本构成", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);
    db.financeFirmPeriodSnapshot.findUnique.mockResolvedValue({
      operatingResult: new Prisma.Decimal("34.00"), firmSalaryCost: new Prisma.Decimal("5.00"),
      firmSocialCost: new Prisma.Decimal("1.00"), firmFundCost: new Prisma.Decimal("1.00"),
      rentCost: new Prisma.Decimal("2.00"), officeCost: new Prisma.Decimal("1.00"),
      turnoverTaxCost: new Prisma.Decimal("1.00"), otherCost: new Prisma.Decimal("0.00")
    });

    const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps);

    expect(result.firm.costBreakdown).toEqual({ salary: "5.00", social: "1.00", fund: "1.00", rent: "2.00", office: "1.00", turnoverTax: "1.00", other: "0.00" });
  });

  it("工作簿页签固定且不输出完整客户名称或账号", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);

    const bytes = await buildFinanceWorkbook({ start, end, groupBy: "ALL" }, deps);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "人员透支表",
      "客户项目归属",
      "案件金额概览",
      "律所经营成果",
      "来源与对账",
      "调整审计"
    ]);
    const projectFacts = workbook.getWorksheet("案件金额概览");
    expect(projectFacts?.getRow(2).values).toEqual(expect.arrayContaining(["案件标的额", "现行签约律师费", "累计已开票净额", "累计确认净收款", "本期分配净额（含退款）"]));
    expect(projectFacts?.getRow(3).getCell(4).value).toBe(350000);
    expect(projectFacts?.getRow(3).getCell(8).value).toBe(100);
    expect(bytes.toString("utf8")).not.toContain("合成客户");
  });

  it("没有财务查看权限的自定义角色被拒绝", async () => {
    const { db } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([]);
    await expect(
      getInternalFinanceSummary({ start, end, groupBy: "ALL" }, { db: db as never, actor: { id: "user-1", role: "CUSTOM", rolePermissions: [] } })
    ).rejects.toThrow("无财务报表权限");
  });
});
