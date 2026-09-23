import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { persistFinancePeriodSnapshots } from "@/server/finance/internal-balances";

function mockTransaction() {
  return {
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([{ userId: "synthetic-lawyer-1", treatmentReviewed: true, selfCostDue: new Prisma.Decimal("100.00"), firmSalaryCost: new Prisma.Decimal("0.00"), firmSocialCost: new Prisma.Decimal("0.00"), firmFundCost: new Prisma.Decimal("0.00") }]) },
    financePersonLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    financePartnerTaxRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeOpeningBalance: { findMany: vi.fn().mockResolvedValue([]) },
    financeCalculationRun: { findFirst: vi.fn().mockResolvedValue(null) },
    financeOperatingCost: { findMany: vi.fn().mockResolvedValue([]) },
    financePersonPeriodSnapshot: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    financeFirmPeriodSnapshot: { create: vi.fn().mockResolvedValue({ id: "firm-snapshot-1" }) }
  };
}

const lines = [{
  grossAmount: "100.00", channelAmount: "20.00", sourceAmount: "10.00", handlingAmount: "20.00", coAmount: "5.00",
  recipients: [{ userId: "synthetic-lawyer-1", amount: "35.00" }]
}];

describe("账期快照持久化", () => {
  it("事务内缺少期初余额时中止，补充确认后同时保存个人和律所快照", async () => {
    const tx = mockTransaction();
    await expect(persistFinancePeriodSnapshots("run-synthetic-1", "2026-08", lines, tx as never)).rejects.toThrow("缺少2026-08期初余额确认");
    expect(tx.financePersonPeriodSnapshot.createMany).not.toHaveBeenCalled();
    expect(tx.financeFirmPeriodSnapshot.create).not.toHaveBeenCalled();

    tx.financeOpeningBalance.findMany.mockResolvedValue([{
      userId: "synthetic-lawyer-1", firstPeriod: "2026-08", distributable: new Prisma.Decimal("0.00"), reserve: new Prisma.Decimal("0.00"), evidenceRef: "synthetic-opening-proof"
    }]);
    const result = await persistFinancePeriodSnapshots("run-synthetic-1", "2026-08", lines, tx as never);

    expect(result.personCount).toBe(1);
    expect(tx.financePersonPeriodSnapshot.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ userId: "synthetic-lawyer-1", earned: "35.00", runId: "run-synthetic-1" })] }));
    expect(tx.financeFirmPeriodSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runId: "run-synthetic-1", feeRevenue: "100.00" }) }));
  });
});
