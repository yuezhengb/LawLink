import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  decideFinanceReconciliation,
  linkFinanceRefund,
  listFinanceReconciliationCases,
  type FinanceReconciliationDependencies
} from "@/server/finance/internal-reconciliation";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-row-1",
    batchId: "batch-1",
    sourceRow: 2,
    occurredAt: new Date("2026-08-01T00:00:00+08:00"),
    amount: new Prisma.Decimal("100.00"),
    direction: "CREDIT",
    balance: null,
    counterpartyDigest: "counterparty-digest",
    counterpartyDisplay: "合成客户",
    accountMasked: "****0001",
    descriptionDigest: "description-digest",
    descriptionDisplay: "合成律师费",
    externalReference: null,
    invoiceReference: null,
    ...overrides
  };
}

function mockDeps() {
  const tx = {
    financeReconciliationCase: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: "case-1", status: "CONFIRMED" })
    },
    payment: {
      findFirst: vi.fn()
    },
    financeClaimDecision: {
      create: vi.fn().mockResolvedValue({ id: "decision-1" })
    },
    financeSourceRow: {
      findUnique: vi.fn()
    },
    financeRefundLink: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "refund-link-1" })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" })
    }
  };
  const db = {
    financeReconciliationCase: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const deps: FinanceReconciliationDependencies = { db: db as never, actor };
  return { db, tx, deps };
}

describe("内部财务对账与认领", () => {
  it("候选查询只取已确认律师费，且为来源行生成可解释建议", async () => {
    const { db, deps } = mockDeps();
    db.financeReconciliationCase.findMany.mockResolvedValue([
      {
        id: "case-1",
        batchId: "batch-1",
        status: "UNRESOLVED",
        paymentId: null,
        sourceRow: sourceRow()
      }
    ]);
    db.payment.findMany.mockResolvedValue([
      {
        id: "payment-1",
        matterId: "matter-1",
        feeEntryId: "fee-1",
        amount: new Prisma.Decimal("100.00"),
        occurredAt: new Date("2026-08-01T00:00:00+08:00"),
        moneyKind: "LAWYER_FEE",
        sourceEntry: { confirmState: "CONFIRMED", invoiceNo: null }
      }
    ]);

    const result = await listFinanceReconciliationCases({ batchId: "batch-1" }, deps);

    expect(result.items[0].suggestions[0]).toMatchObject({ paymentId: "payment-1", score: 90 });
    expect(db.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          moneyKind: "LAWYER_FEE",
          sourceEntry: { confirmState: "CONFIRMED" }
        })
      })
    );
  });

  it("已确认案例重复提交同一决定时幂等，不重复写决定", async () => {
    const { tx, deps } = mockDeps();
    tx.financeReconciliationCase.findUnique.mockResolvedValue({
      id: "case-1",
      status: "CONFIRMED",
      paymentId: "payment-1",
      sourceRow: sourceRow()
    });

    await expect(
      decideFinanceReconciliation({ caseId: "case-1", decision: "CONFIRM", paymentId: "payment-1" }, deps)
    ).resolves.toEqual({ caseId: "case-1", status: "CONFIRMED" });
    expect(tx.financeClaimDecision.create).not.toHaveBeenCalled();
  });

  it("一个付款已经被其他案例确认时阻止第二次确认", async () => {
    const { tx, deps } = mockDeps();
    tx.financeReconciliationCase.findUnique.mockResolvedValue({
      id: "case-1",
      status: "UNRESOLVED",
      paymentId: null,
      sourceRow: sourceRow()
    });
    tx.payment.findFirst.mockResolvedValue({ id: "payment-1", moneyKind: "LAWYER_FEE" });
    tx.financeReconciliationCase.findFirst.mockResolvedValue({ id: "case-other" });

    await expect(
      decideFinanceReconciliation({ caseId: "case-1", decision: "CONFIRM", paymentId: "payment-1" }, deps)
    ).rejects.toThrow("已被其他对账案例确认");
    expect(tx.financeClaimDecision.create).not.toHaveBeenCalled();
  });

  it("同一来源行已有有效退款关联时拒绝第二条关联", async () => {
    const { tx, deps } = mockDeps();
    tx.financeSourceRow.findUnique.mockResolvedValue({
      ...sourceRow({ amount: new Prisma.Decimal("-10.00"), direction: "DEBIT" }),
      reconciliationCase: { id: "case-1" }
    });
    tx.financeRefundLink.findFirst.mockResolvedValue({ id: "refund-old", active: true });

    await expect(
      linkFinanceRefund({ sourceRowId: "source-row-1", paymentId: "payment-1", amount: "10.00", reason: "合成退款" }, deps)
    ).rejects.toThrow("已有有效退款关联");
    expect(tx.financeRefundLink.create).not.toHaveBeenCalled();
  });
});
