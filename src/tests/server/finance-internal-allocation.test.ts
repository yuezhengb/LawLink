import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  commitInternalAllocation,
  previewInternalAllocation,
  type FinanceAllocationDependencies
} from "@/server/finance/internal-allocation";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeCalculationRun: {
      create: vi.fn().mockResolvedValue({ id: "run-preview" }),
      update: vi.fn().mockResolvedValue({ id: "run-preview", status: "COMMITTED" })
    },
    financeAllocationLine: {
      createMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" })
    }
  };
  const db = {
    payment: { findMany: vi.fn() },
    financeRuleVersion: { findFirst: vi.fn() },
    financeCalculationRun: { findUnique: vi.fn() },
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
    occurredAt: new Date("2026-08-01T00:00:00+08:00"),
    moneyKind: "LAWYER_FEE",
    sourceEntry: { confirmState: "CONFIRMED" },
    financeRefundLinks: [],
    matter: {
      id: "synthetic-matter-1",
      financeMatterProfile: {
        origin: "CHANNEL",
        participantIds: ["synthetic-user-1"],
        activeRuleSetId: "rule-set-1"
      },
      commissionPlans: [{ userId: "synthetic-user-1", percent: new Prisma.Decimal("100.00"), active: true }]
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
        effectiveFrom: "2026-08-01",
        effectiveTo: null,
        percentages: { channelRate: "0.10", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.45", coRate: "0.35" },
        fixedAmounts: {},
        roundingMode: "HALF_UP",
        sourceNote: "合成规则"
      },
      roundingMode: "HALF_UP"
    });

    const result = await previewInternalAllocation({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, deps);

    expect(result.blockingIssues).toEqual([]);
    expect(result.lines[0].grossAmount).toBe("100000.00");
    expect(tx.financeAllocationLine.createMany).toHaveBeenCalled();
  });

  it("已提交批次重复提交时直接返回，不重写来源付款", async () => {
    const { db, tx, deps } = mockDeps();
    db.financeCalculationRun.findUnique.mockResolvedValue({ id: "run-committed", status: "COMMITTED" });

    await expect(commitInternalAllocation("run-committed", deps)).resolves.toEqual({ runId: "run-committed", status: "COMMITTED" });
    expect(tx.financeCalculationRun.update).not.toHaveBeenCalled();
    expect(db.payment.findMany).not.toHaveBeenCalled();
  });
});
