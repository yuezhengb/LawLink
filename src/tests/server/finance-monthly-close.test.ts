import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  createFinanceAdjustment,
  downloadFinanceArtifact,
  generateMonthlyClose,
  getMonthlyCloseStatus,
  reverseFinanceAdjustment,
  type MonthlyCloseDependencies
} from "@/server/finance/monthly-close";
import { materializeFinancePeriod } from "@/server/finance/materialization";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeAdjustment: {
      create: vi.fn().mockResolvedValue({ id: "adjustment-1", period: "2026-08", runId: "run-1" }),
      update: vi.fn().mockResolvedValue({ id: "adjustment-1", status: "REVERSED" })
    },
    financeCalculationRun: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "run-new", status: "COMMITTED" }),
      update: vi.fn().mockResolvedValue({ id: "run-old", status: "SUPERSEDED" })
    },
    financeMonthlyClose: {
      upsert: vi.fn().mockResolvedValue({ id: "close-1" })
    },
    financeArtifact: {
      create: vi.fn().mockResolvedValue({ id: "artifact-1" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn()
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) }
  };
  const db = {
    financeImportBatch: { findMany: vi.fn().mockResolvedValue([]) },
    financeReconciliationCase: { count: vi.fn().mockResolvedValue(0) },
    financeCalculationRun: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    financeMonthlyClose: { findUnique: vi.fn().mockResolvedValue(null) },
    financeSourceRow: { findMany: vi.fn().mockResolvedValue([]) },
    financeRefundLink: { findMany: vi.fn().mockResolvedValue([]) },
    financeMatterProfile: { findMany: vi.fn().mockResolvedValue([]) },
    commissionPlan: { findMany: vi.fn().mockResolvedValue([]) },
    financeRuleVersion: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([]) },
    financePartnerTaxRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeCapitalFlow: { findMany: vi.fn().mockResolvedValue([]) },
    financeAdjustment: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    financeArtifact: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const deps: MonthlyCloseDependencies = { db: db as never, actor, storage: { writeFile: vi.fn(), readFile: vi.fn(), deleteFile: vi.fn() } };
  return { db, tx, deps };
}

describe("内部财务月结与调整", () => {
  it("待认领或没有正式分配批次时不能生成正式月结包", async () => {
    const { db, deps } = mockDeps();
    db.financeReconciliationCase.count.mockResolvedValue(1);
    db.financeCalculationRun.findFirst.mockResolvedValue(null);

    const status = await getMonthlyCloseStatus("2026-08", deps);
    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("待认领")]));
    await expect(generateMonthlyClose("2026-08", deps)).rejects.toThrow("存在阻断项");
  });

  it("调整采用追加凭证，冲销不删除原记录", async () => {
    const { db, tx, deps } = mockDeps();
    db.financeCalculationRun.findFirst.mockResolvedValue({ id: "run-1", status: "COMMITTED" });
    const created = await createFinanceAdjustment({ period: "2026-08", account: "user.self_cost", targetUserId: "synthetic-user-1", amount: "100.00", reason: "合成测试调整" }, deps);
    expect(created).toEqual({ id: "adjustment-1", runId: "run-1" });

    db.financeAdjustment.findUnique.mockResolvedValue({ id: "adjustment-1", period: "2026-08", account: "user.self_cost", targetUserId: "synthetic-user-1", amount: new Prisma.Decimal("100.00"), status: "POSTED", reversalOfId: null });
    const reversal = await reverseFinanceAdjustment("adjustment-1", "合成测试冲销", deps);
    expect(reversal.reversalId).toBeTruthy();
    expect(tx.financeAdjustment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "adjustment-1" }, data: { status: "REVERSED" } }));
    expect(tx.financeAdjustment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reversalOfId: "adjustment-1" }) }));
  });

  it("同一来源指纹复用正式批次，来源变化后追加新批次并保留替代关系", async () => {
    const { db, tx, deps } = mockDeps();
    db.financeCalculationRun.findFirst.mockResolvedValueOnce({ id: "run-existing", status: "COMMITTED" });
    const reused = await materializeFinancePeriod({ period: "2026-08" }, deps);
    expect(reused).toMatchObject({ id: "run-existing" });
    expect(db.$transaction).not.toHaveBeenCalled();

    db.financeCalculationRun.findFirst.mockReset();
    db.financeCalculationRun.findFirst.mockResolvedValueOnce(null);
    tx.financeCalculationRun.findFirst.mockResolvedValue({ id: "run-old" });
    const created = await materializeFinancePeriod({ period: "2026-08" }, deps);
    expect(created).toMatchObject({ id: "run-new", status: "COMMITTED" });
    expect(tx.financeCalculationRun.update).toHaveBeenCalledWith({
      where: { id: "run-old" },
      data: { status: "SUPERSEDED", supersededById: "run-new" }
    });
  });

  it("月结交付与同一正式批次绑定，重复生成复用交付记录且下载需要严格审计", async () => {
    const { db, deps } = mockDeps();
    db.financeImportBatch.findMany.mockResolvedValue([{ kind: "BANK_STATEMENT", rowCount: 2 }]);
    db.financeCalculationRun.findFirst.mockResolvedValue({ id: "run-1", sourceHash: "hash-1", summary: {} });
    const writeFile = deps.storage!.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockResolvedValue("finance-artifacts/202609/test.bin");
    const created = await generateMonthlyClose("2026-08", deps);
    expect(created).toHaveLength(5);
    expect(writeFile).toHaveBeenCalledTimes(5);
    expect((db.financeArtifact.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ where: { runId: "run-1" } });

    const existing = Array.from({ length: 5 }, (_, index) => ({ id: `artifact-${index}`, runId: "run-1", kind: index === 4 ? "ZIP" : "WAGE" }));
    db.financeArtifact.findMany.mockResolvedValue(existing);
    const second = await generateMonthlyClose("2026-08", deps);
    expect(second).toBe(existing);
    expect(writeFile).toHaveBeenCalledTimes(5);

    db.financeArtifact.findUnique.mockResolvedValue({ id: "artifact-4", fileName: "LawLink-月结-2026-08.zip", storagePath: "finance-artifacts/202609/test.bin", kind: "ZIP", run: { status: "COMMITTED" } });
    (deps.storage!.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from("zip"));
    const audited: unknown[] = [];
    const download = await downloadFinanceArtifact("artifact-4", { ...deps, auditStrict: async (entry) => { audited.push(entry); } });
    expect(download.fileName).toBe("LawLink-月结-2026-08.zip");
    expect(download.bytes.toString()).toBe("zip");
    expect(audited).toHaveLength(1);
  });
});
