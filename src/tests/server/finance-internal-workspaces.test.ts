import { describe, expect, it, vi } from "vitest";
import {
  buildInternalFinanceOverview,
  listFinanceCounterparties,
} from "@/server/finance/internal-finance-workspaces";

const actor = { id: "synthetic-finance", role: "FINANCE" } as const;

function counterpartyDb() {
  const groupBy = vi.fn(async (args: { by: string[]; where?: Record<string, unknown> }) => {
    if (args.by.length === 1) return [{ counterpartyDigest: "digest-a" }, { counterpartyDigest: "digest-b" }];
    if (JSON.stringify(args.where).includes("CONFIRMED")) return [
      { counterpartyDigest: "digest-a", direction: "CREDIT", _count: { _all: 1 }, _sum: { amount: "35.00" } }
    ];
    if (JSON.stringify(args.where).includes("UNRESOLVED")) return [
      { counterpartyDigest: "digest-a", direction: "CREDIT", _count: { _all: 1 }, _sum: { amount: "35.00" } },
      { counterpartyDigest: "digest-b", direction: "DEBIT", _count: { _all: 2 }, _sum: { amount: "80.00" } }
    ];
    return [
      { counterpartyDigest: "digest-a", direction: "CREDIT", _count: { _all: 2 }, _sum: { amount: "70.00" } },
      { counterpartyDigest: "digest-b", direction: "DEBIT", _count: { _all: 2 }, _sum: { amount: "80.00" } }
    ];
  });
  const db = {
    financeSourceRow: {
      groupBy,
      findMany: vi.fn().mockResolvedValue([
        { counterpartyDigest: "digest-a", counterpartyDisplay: "同一显示名" },
        { counterpartyDigest: "digest-b", counterpartyDisplay: "同一显示名" }
      ])
    }
  };
  return { db, groupBy };
}

describe("律所财务工作区服务", () => {
  it("没有正式计算快照或银行来源时返回未知，不将缺失金额显示为零", () => {
    const result = buildInternalFinanceOverview({
      period: "2026-08",
      closeStatus: { period: "2026-08", ready: false, staleRun: false, coverageConfirmed: false, sourceFiles: 0, sourceKinds: [], transactionCount: 0, unresolvedCount: 0, unresolvedIncomeCount: 0, splitErrorCount: 0, missingPayrollCount: 0, templateWarnings: [], blockingWarnings: [], reviewWarnings: [], runId: null, sourceHash: null },
      summary: { calculationRunId: null, sourceHash: null, sourcePeriod: { start: "2026-08-01", end: "2026-09-01" }, total: "0.00", persons: [], projects: [], firm: { calculationRunId: "", feeRevenue: "0.00", channelAmount: "0.00", firmAmount: "0.00", lawyerAmount: "0.00", operatingResult: null, costBreakdown: null } },
      bank: { committedBatchCount: 0, creditRows: 0, creditAmount: "0.00", debitRows: 0, debitAmount: "0.00", unknownRows: 0, unknownAmount: "0.00", confirmedCreditRows: 0, confirmedCreditAmount: "0.00", unclaimedCreditRows: 0, unclaimedCreditAmount: "0.00" }
    });

    expect(result.officialSnapshot).toBeNull();
    expect(result.bank.creditAmount).toBeNull();
    expect(result.bank.debitAmount).toBeNull();
    expect(result.bank.committedBatchCount).toBe(0);
  });

  it("按 digest 分开同名对象，并将银行来源额、待认领额与已确认关联分列", async () => {
    const { db } = counterpartyDb();
    const result = await listFinanceCounterparties({ period: "2026-08", pageSize: 20 }, actor, { db: db as never });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      digest: "digest-a", display: "同一显示名", creditRows: 2, creditAmount: "70.00",
      confirmedCreditRows: 1, confirmedCreditAmount: "35.00", unclaimedCreditRows: 1, unclaimedCreditAmount: "35.00"
    });
    expect(result.items[1]).toMatchObject({ digest: "digest-b", display: "同一显示名", debitRows: 2, debitAmount: "80.00" });
    expect(result.items[0].confirmedCreditAmount).not.toBe(result.items[0].creditAmount);
  });

  it("使用 keyset 游标翻页，并拒绝无全所财务查看权限的人员", async () => {
    const { db, groupBy } = counterpartyDb();
    await listFinanceCounterparties({ period: "2026-08", pageSize: 1, cursor: "digest-before" }, actor, { db: db as never });
    expect(groupBy.mock.calls[0][0]).toMatchObject({ where: expect.objectContaining({ counterpartyDigest: { not: null, gt: "digest-before" } }), take: 2 });

    const noPermissionDb = counterpartyDb();
    await expect(listFinanceCounterparties({ period: "2026-08" }, { id: "lawyer", role: "LAWYER" }, { db: noPermissionDb.db as never }))
      .rejects.toThrow("无全所财务透视权限");
    expect(noPermissionDb.groupBy).not.toHaveBeenCalled();
  });
});
