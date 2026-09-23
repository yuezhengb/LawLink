import { describe, expect, it } from "vitest";
import { calculatePersonPeriodSnapshot } from "@/server/finance/internal-balances";

describe("律所个人账期快照", () => {
  const facts = {
    userId: "synthetic-lawyer-1",
    period: "2026-09",
    earnedIncome: "10000.00",
    selfCostDue: "30000.00",
    reserveTargetMonthlyCost: "30000.00",
    selfFundingIn: "0.00",
    withdrawn: "0.00",
    partnerTaxAdvance: "0.00",
    unsettledHold: "0.00"
  };

  it("缺少财务确认的首期余额时拒绝生成快照", () => {
    expect(() => calculatePersonPeriodSnapshot(facts)).toThrow("缺少2026-09期初余额确认");
  });

  it("允许有凭据的显式零期初，并只由预存和收入承担成本一次", () => {
    const snapshot = calculatePersonPeriodSnapshot({
      ...facts,
      openingBalance: { firstPeriod: "2026-09", distributable: "0.00", reserve: "20000.00", evidenceRef: "synthetic-opening-proof" }
    });

    expect(snapshot).toMatchObject({
      openingDistributable: "0.00",
      openingReserve: "20000.00",
      selfFundingUsed: "20000.00",
      selfCostChargedToIncome: "10000.00",
      distributableEnd: "0.00",
      reserveEnd: "0.00",
      reserveGap: "60000.00"
    });
  });

  it("从紧邻上月的正式快照结转两个余额，不读取新的期初覆盖", () => {
    const snapshot = calculatePersonPeriodSnapshot({
      ...facts,
      period: "2026-09",
      priorSnapshot: { period: "2026-08", distributableEnd: "5000.00", reserveEnd: "3000.00" }
    });

    expect(snapshot.openingDistributable).toBe("5000.00");
    expect(snapshot.openingReserve).toBe("3000.00");
  });

  it("拒绝不连续的上月快照", () => {
    expect(() => calculatePersonPeriodSnapshot({
      ...facts,
      priorSnapshot: { period: "2026-07", distributableEnd: "1.00", reserveEnd: "2.00" }
    })).toThrow("上期余额快照期间不连续");
  });
});
