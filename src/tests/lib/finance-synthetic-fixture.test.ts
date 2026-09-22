import { describe, expect, it } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";

describe("财务闭环合成事实", () => {
  it("同时覆盖确认收款、待确认收款、退款、工资和资本流", () => {
    const fixture = makeSyntheticFinanceFixture();
    expect(fixture.confirmedPayment.confirmState).toBe("CONFIRMED");
    expect(fixture.pendingReceipt.confirmState).toBe("PENDING");
    expect(fixture.refund.moneyKind).toBe("LAWYER_FEE");
    expect(fixture.capitalFlow.kind).toBe("CAPITAL_IN");
  });
});
