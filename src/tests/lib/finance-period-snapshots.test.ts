import { describe, expect, it } from "vitest";
import { calculateFinancePeriodSnapshots } from "@/server/finance/internal-balances";

describe("正式财务账期快照", () => {
  it("从分配收款、复核工资、期初和实际经营成本生成个人与律所快照", () => {
    const result = calculateFinancePeriodSnapshots({
      period: "2026-09",
      allocationLines: [{
        grossAmount: "100000.00", channelAmount: "20000.00",
        sourceAmount: "7000.00", handlingAmount: "17500.00", coAmount: "10500.00",
        recipients: [{ userId: "synthetic-lawyer-1", amount: "35000.00" }]
      }],
      payrollFacts: [{
        userId: "synthetic-lawyer-1", treatmentReviewed: true, selfCostDue: "30000.00",
        firmSalaryCost: "5000.00", firmSocialCost: "1000.00", firmFundCost: "1000.00"
      }],
      ledgerEntries: [],
      taxRecords: [{ userId: "synthetic-lawyer-1", firmAdvance: "2000.00" }],
      openingBalances: [{ userId: "synthetic-lawyer-1", firstPeriod: "2026-09", distributable: "0.00", reserve: "20000.00", evidenceRef: "synthetic-opening" }],
      priorSnapshots: [],
      operatingCosts: [
        { category: "RENT", amount: "2000.00" },
        { category: "OFFICE", amount: "1000.00" },
        { category: "TURNOVER_TAX", amount: "1000.00" }
      ]
    });

    expect(result.personSnapshots[0]).toMatchObject({
      earned: "35000.00", selfFundingUsed: "20000.00", selfCostChargedToIncome: "10000.00",
      partnerTaxAdvance: "2000.00", distributableEnd: "23000.00", reserveEnd: "0.00"
    });
    expect(result.firmSnapshot).toMatchObject({
      feeRevenue: "100000.00", channelAmount: "20000.00", lawyerAmount: "35000.00",
      firmSalaryCost: "5000.00", firmSocialCost: "1000.00", firmFundCost: "1000.00",
      rentCost: "2000.00", officeCost: "1000.00", turnoverTaxCost: "1000.00", operatingResult: "34000.00"
    });
  });

  it("拒绝未复核的工资承担口径", () => {
    expect(() => calculateFinancePeriodSnapshots({
      period: "2026-09", allocationLines: [],
      payrollFacts: [{ userId: "synthetic-lawyer-1", treatmentReviewed: false, selfCostDue: "0.00", firmSalaryCost: "0.00", firmSocialCost: "0.00", firmFundCost: "0.00" }],
      ledgerEntries: [], taxRecords: [], openingBalances: [], priorSnapshots: [], operatingCosts: []
    })).toThrow("工资承担口径尚未复核");
  });
});
