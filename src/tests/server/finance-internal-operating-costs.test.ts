import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { saveFinanceOperatingCost, type FinanceOperatingCostDependencies } from "@/server/finance/internal-operating-costs";

const actor = { id: "synthetic-finance-1", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeSourceRow: { findUnique: vi.fn() },
    financeOperatingCost: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "operating-cost-1" })
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) }
  };
  const db = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) };
  const deps = { db: db as never, actor } satisfies FinanceOperatingCostDependencies;
  return { db, tx, deps };
}

describe("律所实际经营成本", () => {
  it("分类银行支出前必须是同月已归档银行来源行", async () => {
    const { tx, deps } = mockDeps();
    tx.financeSourceRow.findUnique.mockResolvedValue({
      id: "synthetic-bank-row-1", occurredAt: new Date("2026-08-01T00:00:00+08:00"),
      direction: "CREDIT", amount: new Prisma.Decimal("3000.00"), batch: { kind: "BANK_STATEMENT", status: "COMMITTED" }
    });

    await expect(saveFinanceOperatingCost({
      period: "2026-08", category: "RENT", amount: "3000.00", sourceRowId: "synthetic-bank-row-1", description: "合成房租"
    }, deps)).rejects.toThrow("只能分类同月已归档的银行支出");
  });

  it("同一银行支出的多项成本分类之和不得超过原支出", async () => {
    const { tx, deps } = mockDeps();
    tx.financeSourceRow.findUnique.mockResolvedValue({
      id: "synthetic-bank-row-1", occurredAt: new Date("2026-08-01T00:00:00+08:00"),
      direction: "DEBIT", amount: new Prisma.Decimal("-3000.00"), batch: { kind: "BANK_STATEMENT", status: "COMMITTED" }
    });
    tx.financeOperatingCost.findMany.mockResolvedValue([{ amount: new Prisma.Decimal("2000.00") }]);

    await expect(saveFinanceOperatingCost({
      period: "2026-08", category: "OFFICE", amount: "1500.00", sourceRowId: "synthetic-bank-row-1", description: "合成办公支出"
    }, deps)).rejects.toThrow("分类金额超过银行支出余额");
    expect(tx.financeOperatingCost.create).not.toHaveBeenCalled();
  });

  it("无银行来源时要求凭据引用并由财务调整权限保存", async () => {
    const { tx, deps } = mockDeps();
    await expect(saveFinanceOperatingCost({
      period: "2026-08", category: "OTHER", amount: "500.00", description: "合成成本"
    }, deps)).rejects.toThrow("没有银行来源时必须填写凭据引用");
    expect(tx.financeOperatingCost.create).not.toHaveBeenCalled();
  });
});
