import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  commitInternalAllocation,
  currentAllocationSourceHash,
  previewInternalAllocation,
  type FinanceAllocationDependencies
} from "@/server/finance/internal-allocation";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeCalculationRun: {
      create: vi.fn().mockResolvedValue({ id: "run-preview" }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: "run-preview", status: "COMMITTED" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    financeAllocationLine: {
      createMany: vi.fn().mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }))
    },
    financeAllocationRecipient: {
      createMany: vi.fn().mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }))
    },
    financePersonPeriodSnapshot: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    financeFirmPeriodSnapshot: { create: vi.fn().mockResolvedValue({ id: "firm-snapshot-1" }) },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" })
    }
  };
  const db = {
    payment: { findMany: vi.fn() },
    financeRuleVersion: { findFirst: vi.fn() },
    financeCalculationRun: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    financeAllocationLine: { findMany: vi.fn().mockResolvedValue([]) },
    financeRefundLink: { findMany: vi.fn().mockResolvedValue([]) },
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([
      { id: "payroll-1", userId: "synthetic-user-1", treatmentReviewed: true, grossSalary: new Prisma.Decimal("0.00"), actualCashPaid: new Prisma.Decimal("0.00"), selfCostDue: new Prisma.Decimal("0.00"), firmSalaryCost: new Prisma.Decimal("0.00"), firmSocialCost: new Prisma.Decimal("0.00"), firmFundCost: new Prisma.Decimal("0.00") },
      { id: "payroll-2", userId: "synthetic-user-2", treatmentReviewed: true, grossSalary: new Prisma.Decimal("0.00"), actualCashPaid: new Prisma.Decimal("0.00"), selfCostDue: new Prisma.Decimal("0.00"), firmSalaryCost: new Prisma.Decimal("0.00"), firmSocialCost: new Prisma.Decimal("0.00"), firmFundCost: new Prisma.Decimal("0.00") }
    ]) },
    financePersonLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    financePartnerTaxRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeOpeningBalance: { findMany: vi.fn().mockResolvedValue([
      { id: "opening-1", userId: "synthetic-user-1", firstPeriod: "2026-08", distributable: new Prisma.Decimal("0.00"), reserve: new Prisma.Decimal("0.00"), evidenceRef: "synthetic-proof-1" },
      { id: "opening-2", userId: "synthetic-user-2", firstPeriod: "2026-08", distributable: new Prisma.Decimal("0.00"), reserve: new Prisma.Decimal("0.00"), evidenceRef: "synthetic-proof-2" }
    ]) },
    financeOperatingCost: { findMany: vi.fn().mockResolvedValue([]) },
    financeCapitalFlow: { findMany: vi.fn().mockResolvedValue([]) },
    financeAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: "synthetic-user-1" }, { id: "synthetic-user-2" }]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const deps: FinanceAllocationDependencies = { db: db as never, actor };
  return { db, tx, deps };
}

function paymentWithSetup() {
  return {
    id: "synthetic-payment-1",
    matterId: "synthetic-matter-1",
    amount: new Prisma.Decimal("100000.00"),
    refundedAmount: new Prisma.Decimal("0.00"),
    occurredAt: new Date("2026-08-01T00:00:00+08:00"),
    moneyKind: "LAWYER_FEE",
    sourceEntry: {
      confirmState: "CONFIRMED",
      matterId: "synthetic-matter-1",
      moneyKind: "LAWYER_FEE",
      amount: new Prisma.Decimal("100000.00"),
      commissionChildren: [
        { type: "COMMISSION", confirmState: "CONFIRMED", beneficiaryUserId: "synthetic-user-1", amount: new Prisma.Decimal("19250.00"), commissionRateSnapshot: new Prisma.Decimal("19.25"), commissionBaseSnapshot: new Prisma.Decimal("100000.00") },
        { type: "COMMISSION", confirmState: "CONFIRMED", beneficiaryUserId: "synthetic-user-2", amount: new Prisma.Decimal("15750.00"), commissionRateSnapshot: new Prisma.Decimal("15.75"), commissionBaseSnapshot: new Prisma.Decimal("100000.00") }
      ]
    },
    financeRefundLinks: [],
    matter: {
      id: "synthetic-matter-1",
      financeMatterProfile: {
        origin: "CHANNEL",
        participantIds: ["synthetic-user-1"],
        roleAssignments: [
          { role: "SOURCE", userId: "synthetic-user-1", shareRate: "1" },
          { role: "HANDLING", userId: "synthetic-user-1", shareRate: "0.7" },
          { role: "HANDLING", userId: "synthetic-user-2", shareRate: "0.3" },
          { role: "CO", userId: "synthetic-user-2", shareRate: "1" }
        ],
        activeRuleSetId: "rule-set-1"
      },
      commissionPlans: [
        { userId: "synthetic-user-1", percent: new Prisma.Decimal("19.25"), active: true },
        { userId: "synthetic-user-2", percent: new Prisma.Decimal("15.75"), active: true }
      ]
    }
  };
}

describe("内部财务分配持久化", () => {
  it("缺少案件画像、分成方案或规则时生成阻断项", async () => {
    const { db, tx, deps } = mockDeps();
    db.payment.findMany.mockResolvedValue([
      { ...paymentWithSetup(), matter: { id: "matter-1", financeMatterProfile: null, commissionPlans: [] } }
    ]);
    const result = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(result.blockingIssues).toEqual(expect.arrayContaining([expect.stringContaining("财务画像")]));
    expect(tx.financeCalculationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PREVIEW" }) }));
  });

  it("配置齐全时分配行金额守恒并生成预览批次", async () => {
    const { db, tx, deps } = mockDeps();
    db.payment.findMany.mockResolvedValue([paymentWithSetup()]);
    db.financeRuleVersion.findFirst.mockResolvedValue({
      id: "rule-version-1",
      definition: {
        kind: "CHANNEL",
        calculationBase: "GROSS",
        effectiveFrom: "2026-08-01",
        effectiveTo: null,
        percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
        fixedAmounts: {},
        roundingMode: "HALF_UP",
        sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });

    const result = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(result.blockingIssues).toEqual([]);
    expect(result.lines[0].grossAmount).toBe("100000.00");
    expect(result.lines[0].firmAmount).toBe("45000.00");
    expect(result.recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "synthetic-user-1", role: "SOURCE", amount: "7000.00" }),
      expect.objectContaining({ userId: "synthetic-user-1", role: "HANDLING", amount: "12250.00" }),
      expect.objectContaining({ userId: "synthetic-user-2", role: "HANDLING", amount: "5250.00" }),
      expect.objectContaining({ userId: "synthetic-user-2", role: "CO", amount: "10500.00" })
    ]));
    expect(tx.financeAllocationLine.createMany).toHaveBeenCalled();
    expect(tx.financeAllocationRecipient.createMany).toHaveBeenCalled();
    expect(tx.financeAllocationLine.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        sourceKind: "PAYMENT",
        refundLinkId: null,
        sourceOccurredAt: expect.any(Date),
        grossAmount: "100000.00"
      })]
    }));
    expect(tx.financeAllocationRecipient.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: "synthetic-user-1", role: "SOURCE", amount: "7000.00" }),
        expect.objectContaining({ userId: "synthetic-user-2", role: "CO", amount: "10500.00" })
      ])
    }));
    expect(result.allocationVersion).toBe(2);
  });

  it("退款按原分配比例冲回本期，并使来源指纹变化", async () => {
    const { db, deps } = mockDeps();
    const payment = { ...paymentWithSetup(), refundedAmount: new Prisma.Decimal("20000.00") };
    db.payment.findMany.mockResolvedValue([payment]);
    const beforeRefund = await currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: db as never });
    db.financeRefundLink.findMany.mockResolvedValue([{
      id: "synthetic-refund-link-1",
      paymentId: payment.id,
      amount: new Prisma.Decimal("20000.00"),
      sourceRow: { id: "synthetic-refund-source-1", occurredAt: new Date("2026-08-20T00:00:00+08:00"), amount: new Prisma.Decimal("-20000.00"), direction: "DEBIT" },
      payment
    }]);
    db.financeRuleVersion.findFirst.mockResolvedValue({
      id: "rule-version-1",
      definition: {
        kind: "CHANNEL", calculationBase: "GROSS", effectiveFrom: "2026-08-01", effectiveTo: null,
        percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
        fixedAmounts: {}, roundingMode: "HALF_UP", sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });

    const preview = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);
    const refundLine = preview.lines.find((line) => line.sourceKind === "REFUND");
    const afterRefund = await currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: db as never });

    expect(preview.blockingIssues).toEqual([]);
    expect(refundLine).toMatchObject({ refundLinkId: "synthetic-refund-link-1", grossAmount: "-20000.00", channelAmount: "-4000.00", firmAmount: "-9000.00", sourceAmount: "-1400.00", handlingAmount: "-3500.00", coAmount: "-2100.00" });
    expect(refundLine?.recipients.reduce((sum, recipient) => sum.plus(recipient.amount), new Prisma.Decimal(0)).toFixed(2)).toBe("-7000.00");
    expect(afterRefund).not.toBe(beforeRefund);
  });

  it("仅退款月份可用历史正式分配比例冲回，缺少历史分配时阻断", async () => {
    const { db, deps } = mockDeps();
    const oldPayment = { ...paymentWithSetup(), occurredAt: new Date("2026-07-15T00:00:00+08:00"), refundedAmount: new Prisma.Decimal("20000.00") };
    db.payment.findMany.mockResolvedValue([]);
    db.financeRefundLink.findMany.mockResolvedValue([{
      id: "synthetic-refund-link-2", paymentId: oldPayment.id, amount: new Prisma.Decimal("20000.00"),
      sourceRow: { id: "synthetic-refund-source-2", occurredAt: new Date("2026-08-20T00:00:00+08:00"), amount: new Prisma.Decimal("-20000.00"), direction: "DEBIT" },
      payment: oldPayment
    }]);
    db.financeAllocationLine.findMany.mockResolvedValue([{
      id: "synthetic-original-line", paymentId: oldPayment.id, matterId: oldPayment.matterId, targetUserId: null,
      sourceKind: "PAYMENT", refundLinkId: null, sourceOccurredAt: oldPayment.occurredAt, ruleVersionId: "rule-version-1",
      grossAmount: new Prisma.Decimal("100000.00"), channelAmount: new Prisma.Decimal("20000.00"), firmAmount: new Prisma.Decimal("45000.00"),
      sourceAmount: new Prisma.Decimal("7000.00"), handlingAmount: new Prisma.Decimal("17500.00"), coAmount: new Prisma.Decimal("10500.00"),
      recipients: [
        { userId: "synthetic-user-1", role: "SOURCE", shareRate: new Prisma.Decimal("1"), amount: new Prisma.Decimal("7000.00") },
        { userId: "synthetic-user-1", role: "HANDLING", shareRate: new Prisma.Decimal("0.7"), amount: new Prisma.Decimal("12250.00") },
        { userId: "synthetic-user-2", role: "HANDLING", shareRate: new Prisma.Decimal("0.3"), amount: new Prisma.Decimal("5250.00") },
        { userId: "synthetic-user-2", role: "CO", shareRate: new Prisma.Decimal("1"), amount: new Prisma.Decimal("10500.00") }
      ], run: { status: "COMMITTED", supersededById: null, calculatedAt: new Date("2026-08-01T00:00:00+08:00") }
    }]);

    const preview = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(preview.blockingIssues).toEqual([]);
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatchObject({ sourceKind: "REFUND", grossAmount: "-20000.00", matterId: oldPayment.matterId });

    db.financeAllocationLine.findMany.mockResolvedValue([]);
    const withoutOriginal = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);
    expect(withoutOriginal.blockingIssues).toEqual(expect.arrayContaining([expect.stringContaining("原正式分配快照")]));
  });

  it("未确认工资承担口径或首期余额时不能给出可提交的预览", async () => {
    const { db, deps } = mockDeps();
    db.financePayrollFact.findMany.mockResolvedValue([]);
    db.financeOpeningBalance.findMany.mockResolvedValue([]);
    db.payment.findMany.mockResolvedValue([paymentWithSetup()]);
    db.financeRuleVersion.findFirst.mockResolvedValue({
      id: "rule-version-1",
      definition: {
        kind: "CHANNEL", calculationBase: "GROSS", effectiveFrom: "2026-08-01", effectiveTo: null,
        percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
        fixedAmounts: {}, roundingMode: "HALF_UP", sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });

    const preview = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(preview.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("工资承担口径"),
      expect.stringContaining("期初余额")
    ]));
  });

  it("同一来源哈希的预览幂等复用，避免重复创建批次", async () => {
    const { db, tx, deps } = mockDeps();
    db.payment.findMany.mockResolvedValue([paymentWithSetup()]);
    db.financeRuleVersion.findFirst.mockResolvedValue({
      id: "rule-version-1",
      definition: {
        kind: "CHANNEL", calculationBase: "GROSS", effectiveFrom: "2026-08-01", effectiveTo: null,
        percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
        fixedAmounts: {}, roundingMode: "HALF_UP", sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });
    db.financeCalculationRun.findUnique.mockResolvedValue({
      id: "run-existing",
      periodStart: new Date("2026-08-01T00:00:00+08:00"),
      periodEnd: new Date("2026-09-01T00:00:00+08:00"),
      sourceHash: "existing-hash",
      status: "PREVIEW",
      summary: { allocationVersion: 2, blockingIssues: ["stored blocker"], lineCount: 1, recipientCount: 4 },
      allocationLines: []
    });

    const result = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(result.runId).toBe("run-existing");
    expect(result.blockingIssues).toEqual(["stored blocker"]);
    expect(tx.financeCalculationRun.create).not.toHaveBeenCalled();
    expect(tx.financeAllocationLine.createMany).not.toHaveBeenCalled();
  });

  it("新分配与已确认佣金子账不一致时阻断而不覆盖子账", async () => {
    const { db, tx, deps } = mockDeps();
    const payment = paymentWithSetup();
    payment.sourceEntry.commissionChildren[0].amount = new Prisma.Decimal("20000.00");
    db.payment.findMany.mockResolvedValue([payment]);
    db.financeRuleVersion.findFirst.mockResolvedValue({
      id: "rule-version-1",
      definition: {
        kind: "CHANNEL", calculationBase: "GROSS", effectiveFrom: "2026-08-01", effectiveTo: null,
        percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
        fixedAmounts: {}, roundingMode: "HALF_UP", sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });

    const result = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(result.blockingIssues).toEqual(expect.arrayContaining([expect.stringContaining("提成快照不一致")]));
    expect(tx.financeAllocationRecipient.createMany).toHaveBeenCalled();
  });

  it("已提交批次重复提交时直接返回，不重写来源付款", async () => {
    const { db, tx, deps } = mockDeps();
    db.financeCalculationRun.findUnique.mockResolvedValue({ id: "run-committed", status: "COMMITTED" });

    await expect(commitInternalAllocation("run-committed", deps)).resolves.toEqual({ runId: "run-committed", status: "COMMITTED" });
    expect(tx.financeCalculationRun.update).not.toHaveBeenCalled();
    expect(db.payment.findMany).not.toHaveBeenCalled();
  });

  it("存在阻断项的预览不能提交", async () => {
    const { db, tx, deps } = mockDeps();
    db.financeCalculationRun.findUnique.mockResolvedValue({
      id: "run-blocked", status: "PREVIEW", sourceHash: "hash",
      periodStart: new Date("2026-08-01T00:00:00+08:00"), periodEnd: new Date("2026-09-01T00:00:00+08:00"),
      summary: { allocationVersion: 2, blockingIssues: ["needs correction"], lineCount: 1, recipientCount: 4 },
      allocationLines: [{ id: "line-1", recipients: [{ id: "recipient-1" }] }]
    });

    await expect(commitInternalAllocation("run-blocked", deps)).rejects.toThrow("存在阻断项");
    expect(db.payment.findMany).not.toHaveBeenCalled();
    expect(tx.financeCalculationRun.update).not.toHaveBeenCalled();
  });
});
