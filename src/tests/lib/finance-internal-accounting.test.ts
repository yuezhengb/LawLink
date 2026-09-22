import { describe, expect, it } from "vitest";
import { buildFirmOperatingResult, buildPersonalDoubleBalance } from "@/lib/finance/internal-accounting";

describe("个人双余额与律所经营结果", () => {
  it("收入余额与自担预存余额分开计算", () => {
    const result = buildPersonalDoubleBalance({
      openingDistributable: "0.00",
      openingReserve: "20000.00",
      earnedIncome: "10000.00",
      selfCostDue: "30000.00",
      selfFundingIn: "0.00",
      withdrawn: "0.00",
      partnerTaxAdvance: "0.00",
      unsettledHold: "0.00"
    });
    expect(result.selfFundingUsed).toBe("20000.00");
    expect(result.selfFundingReserveEnd).toBe("0.00");
    expect(result.reserveGap).toBe("40000.00");
    expect(result.distributableEnd).toBe("-20000.00");
  });

  it("收入提取和个人税款预付不重复进入律所经营成本", () => {
    const result = buildFirmOperatingResult({
      feeRevenue: "100.00",
      incomeWithdrawal: "80.00",
      partnerTaxAdvance: "20.00",
      firmSalary: "0.00",
      firmSocial: "0.00",
      rent: "0.00",
      channel: "0.00",
      lawyer: "0.00",
      taxes: "0.00"
    });
    expect(result.operatingResult).toBe("100.00");
  });

  it("负余额和资金缺口不被截断为零", () => {
    const result = buildPersonalDoubleBalance({
      openingDistributable: "-100.00",
      openingReserve: "0.00",
      earnedIncome: "0.00",
      selfCostDue: "100.00",
      selfFundingIn: "0.00",
      withdrawn: "50.00",
      partnerTaxAdvance: "25.00",
      unsettledHold: "10.00"
    });
    expect(result.distributableEnd).toBe("-285.00");
    expect(result.reserveGap).toBe("200.00");
  });
});
