import { describe, expect, it } from "vitest";
import { rankPaymentCandidates } from "@/lib/finance/internal-matching";
import type { ConfirmedPaymentCandidate, FinanceNormalizedRow } from "@/lib/finance/internal-types";

function row(date: string, amount: string, direction: "CREDIT" | "DEBIT" = "CREDIT"): FinanceNormalizedRow {
  return {
    sourceKind: "BANK_STATEMENT",
    sourceRowNumber: 2,
    occurredAt: date,
    amount,
    direction,
    counterparty: "合成客户",
    counterpartyDigest: "synthetic-counterparty",
    description: "合成律师费",
    descriptionDigest: "synthetic-description",
    externalReference: null,
    invoiceReference: null
  };
}

function payment(id: string, date: string, amount: string): ConfirmedPaymentCandidate {
  return {
    paymentId: id,
    matterId: "synthetic-matter-1",
    feeEntryId: `fee-${id}`,
    occurredAt: date,
    amount,
    moneyKind: "LAWYER_FEE",
    confirmState: "CONFIRMED"
  };
}

describe("财务内部对账匹配", () => {
  it("同金额同上海日期优先于仅金额相同的候选", () => {
    const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
      payment("p-same-day", "2026-08-01", "100.00"),
      payment("p-window", "2026-08-03", "100.00")
    ]);
    expect(result[0]).toMatchObject({ paymentId: "p-same-day", score: 90, confidence: "HIGH" });
  });

  it("同分候选进入疑点而不是自动确认", () => {
    const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
      payment("p-1", "2026-08-01", "100.00"),
      payment("p-2", "2026-08-01", "100.00")
    ]);
    expect(result.every((item) => item.autoConfirm === false)).toBe(true);
  });

  it("金额不同即使摘要相同也不产生自动候选", () => {
    expect(rankPaymentCandidates(row("2026-08-01", "100.01"), [payment("p", "2026-08-01", "100.00")])).toEqual([]);
  });

  it("相同外部流水号获得最高分且可自动确认", () => {
    const source = { ...row("2026-08-01", "100.00"), externalReference: "bank-ref-1" };
    const candidate = { ...payment("p-ref", "2026-08-05", "100.00"), externalReference: "bank-ref-1" };
    expect(rankPaymentCandidates(source, [candidate])[0]).toMatchObject({ score: 100, autoConfirm: true });
  });

  it("待确认、非律师费和已被占用的付款不会进入候选", () => {
    const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
      payment("p-ok", "2026-08-01", "100.00"),
      { ...payment("p-pending", "2026-08-01", "100.00"), confirmState: "PENDING" as never },
      { ...payment("p-cost", "2026-08-01", "100.00"), moneyKind: "COST" as never },
      { ...payment("p-used", "2026-08-01", "100.00"), alreadyUsed: true }
    ]);
    expect(result.map((item) => item.paymentId)).toEqual(["p-ok"]);
  });

  it("支出行不自动认领收入付款", () => {
    expect(rankPaymentCandidates(row("2026-08-01", "100.00", "DEBIT"), [payment("p", "2026-08-01", "100.00")])).toEqual([]);
  });
});
