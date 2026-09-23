import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import PizZip from "pizzip";
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
import { currentAllocationSourceHash } from "@/server/finance/internal-allocation";
import { buildCloseZip } from "@/server/finance/internal-export";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeAdjustment: {
      create: vi.fn().mockResolvedValue({ id: "adjustment-1", period: "2026-08", runId: "run-1" }),
      update: vi.fn().mockResolvedValue({ id: "adjustment-1", status: "REVERSED" })
    },
    financeCalculationRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "run-new", status: "PREVIEW" }),
      update: vi.fn().mockResolvedValue({ id: "run-old", status: "SUPERSEDED" })
    },
    financeAllocationLine: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    financeAllocationRecipient: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    financeMonthlyClose: {
      upsert: vi.fn().mockResolvedValue({ id: "close-1" }),
      create: vi.fn().mockResolvedValue({ id: "close-1" }),
      findFirst: vi.fn().mockResolvedValue(null)
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
    financeCalculationRun: { findFirst: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    financeMonthlyClose: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    financePeriodCoverage: { findUnique: vi.fn().mockResolvedValue(null) },
    financeSourceRow: { findMany: vi.fn().mockResolvedValue([]) },
    financeRefundLink: { findMany: vi.fn().mockResolvedValue([]) },
    financeMatterProfile: { findMany: vi.fn().mockResolvedValue([]) },
    commissionPlan: { findMany: vi.fn().mockResolvedValue([]) },
    financeRuleVersion: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([]) },
    financePersonLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    financeOpeningBalance: { findMany: vi.fn().mockResolvedValue([]) },
    financeOperatingCost: { findMany: vi.fn().mockResolvedValue([]) },
    financePartnerTaxRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeCapitalFlow: { findMany: vi.fn().mockResolvedValue([]) },
    financeAdjustment: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    financeImportRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeFirmPeriodSnapshot: { findUnique: vi.fn().mockResolvedValue(null) },
    financePersonPeriodSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    financeArtifact: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    billing: { findMany: vi.fn().mockResolvedValue([]) },
    invoiceRequest: { findMany: vi.fn().mockResolvedValue([]) },
    invoiceAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
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
    const preview = await materializeFinancePeriod({ period: "2026-08" }, deps);
    expect(preview).toMatchObject({ status: "PREVIEW", allocationVersion: 2 });
    expect(preview.blockingIssues).toEqual(expect.arrayContaining([expect.stringContaining("没有已确认律师费收款")]));
    expect(tx.financeCalculationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PREVIEW", trigger: "PREVIEW" }) }));
    expect(tx.financeCalculationRun.update).not.toHaveBeenCalled();
    expect(db.financeCalculationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ include: { personPeriodSnapshots: true } }));
  });

  it("ZIP 保存四类独立工作簿的原始字节和一致的批次摘要", () => {
    const files = {
      WAGE: Buffer.from("synthetic-wage-xlsx"),
      ACCOUNTANT: Buffer.from("synthetic-accountant-xlsx"),
      PERSONAL: Buffer.from("synthetic-personal-xlsx"),
      ADJUSTMENT_AUDIT: Buffer.from("synthetic-adjustment-xlsx")
    };
    const bytes = buildCloseZip("2026-08", "synthetic-run", files, "synthetic-hash");
    const zip = new PizZip(bytes);
    expect(zip.file(/\.xlsx$/).map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "工资-2026-08.xlsx", "会计资料-2026-08.xlsx", "个人内账-2026-08.xlsx", "调整审计-2026-08.xlsx"
    ]));
    expect(zip.file("README.txt")?.asText()).toContain("synthetic-hash");
    for (const [kind, filename] of Object.entries({ WAGE: "工资-2026-08.xlsx", ACCOUNTANT: "会计资料-2026-08.xlsx", PERSONAL: "个人内账-2026-08.xlsx", ADJUSTMENT_AUDIT: "调整审计-2026-08.xlsx" })) {
      const extracted = zip.file(filename)?.asNodeBuffer();
      expect(extracted?.equals(files[kind as keyof typeof files])).toBe(true);
      expect(createHash("sha256").update(extracted ?? Buffer.alloc(0)).digest("hex")).toBe(createHash("sha256").update(files[kind as keyof typeof files]).digest("hex"));
    }
    expect(new Set(Object.values(files).map((bytes) => createHash("sha256").update(bytes).digest("hex"))).size).toBe(4);
  });

  it("只有财务读取权限、没有财务导出权限时不能生成交付包", async () => {
    const { db } = mockDeps();
    const readerOnly = {
      db: db as never,
      actor: { id: "synthetic-reader", role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "ALL" }] as never }
    } satisfies MonthlyCloseDependencies;

    await expect(generateMonthlyClose("2026-08", readerOnly)).rejects.toThrow("无权导出财务交付");
    expect(db.financeArtifact.findMany).not.toHaveBeenCalled();
  });

  it("旧版或摘要缺字段的批次不能通过月结闸门", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findFirst.mockResolvedValue({ id: "run-legacy", sourceHash: "legacy-hash", summary: {}, allocationLines: [] });

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("新版分配快照")]));
  });

  it("正式批次来源指纹过期时不能月结", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findFirst.mockResolvedValue({
      id: "run-stale", sourceHash: "old-source-hash",
      summary: { allocationVersion: 2, snapshotVersion: "personal-v1", blockingIssues: [], lineCount: 0, recipientCount: 0, paymentCount: 0, refundCount: 0, personSnapshotCount: 0, firmSnapshotCount: 1, missingPayrollCount: 0, splitErrorCount: 0 },
      allocationLines: [], personPeriodSnapshots: [], firmPeriodSnapshot: { id: "firm-snapshot-1" }
    });

    await expect(currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: db as never })).resolves.toMatch(/^[a-f0-9]{64}$/);

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("来源已变化")]));
  });

  it("预览统计与持久化行数不符时不能通过月结", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findFirst.mockResolvedValue({
      id: "run-count-mismatch", sourceHash: "hash",
      summary: { allocationVersion: 2, blockingIssues: [], lineCount: 2, recipientCount: 1, paymentCount: 2, refundCount: 0 },
      allocationLines: [{ recipients: [{ id: "recipient-1" }] }]
    });

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("明细数量不一致")]));
  });

  it("即便已有完整的新版分配与经营快照，未确认来源覆盖仍不能月结", async () => {
    const { db, deps } = mockDeps();
    const sourceHash = await currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: db as never });
    const coverageRun = {
      id: "run-coverage", sourceHash,
      summary: { allocationVersion: 2, snapshotVersion: "personal-v1", blockingIssues: [], lineCount: 0, recipientCount: 0, paymentCount: 0, refundCount: 0, personSnapshotCount: 0, firmSnapshotCount: 1, missingPayrollCount: 0, splitErrorCount: 0 },
      allocationLines: [], personPeriodSnapshots: [], firmPeriodSnapshot: { id: "firm-snapshot-coverage" }
    };
    const monthEnd = new Date("2026-09-01T00:00:00+08:00").getTime();
    db.financeCalculationRun.findFirst.mockImplementation(({ where }: { where: { periodEnd?: Date } }) => Promise.resolve(where.periodEnd?.getTime() === monthEnd ? coverageRun : null));

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toContain("尚未确认本期银行、工资与花名册来源覆盖");
  });

  it("外部三表只导入部分报表时明确列出缺失项", async () => {
    const { db, deps } = mockDeps();
    const start = new Date("2026-08-01T00:00:00+08:00");
    const end = new Date("2026-09-01T00:00:00+08:00");
    const bankBatch = { id: "synthetic-bank-batch", kind: "BANK_STATEMENT", rowCount: 1, periodStart: start, periodEnd: end };
    const externalBatch = { id: "synthetic-external-batch", kind: "EXTERNAL_THREE_STATEMENTS", rowCount: 1, periodStart: start, periodEnd: end };
    db.financeImportBatch.findMany.mockResolvedValue([bankBatch, externalBatch]);
    db.financePeriodCoverage.findUnique.mockResolvedValue({ details: {
      bankAccounts: [{ alias: "合成基本户", batchIds: [bankBatch.id] }],
      payrollBatchIds: [], noPayrollReason: "合成测试不录入工资",
      rosterBatchIds: [], noRosterReason: "合成测试不更新花名册",
      externalBatchIds: [externalBatch.id]
    } });
    db.financeImportRecord.findMany.mockResolvedValue([{ batchId: externalBatch.id, kind: "EXTERNAL_THREE_STATEMENTS", statement: "BALANCE_SHEET", reviewStatus: "NEEDS_REVIEW" }]);

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.reviewWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("利润表"),
      expect.stringContaining("现金流量表"),
      expect.stringContaining("1 行尚未人工核对")
    ]));
  });

  it("工资或花名册导入行未完成财务人工关联时阻断月结", async () => {
    const { db, deps } = mockDeps();
    const start = new Date("2026-08-01T00:00:00+08:00");
    const end = new Date("2026-09-01T00:00:00+08:00");
    const batches = [
      { id: "synthetic-bank-batch", kind: "BANK_STATEMENT", rowCount: 1, periodStart: start, periodEnd: end },
      { id: "synthetic-payroll-batch", kind: "PAYROLL", rowCount: 1, periodStart: start, periodEnd: end },
      { id: "synthetic-roster-batch", kind: "ROSTER", rowCount: 1, periodStart: start, periodEnd: end }
    ];
    db.financeImportBatch.findMany.mockResolvedValue(batches);
    db.financePeriodCoverage.findUnique.mockResolvedValue({ details: {
      bankAccounts: [{ alias: "合成基本户", batchIds: ["synthetic-bank-batch"] }],
      payrollBatchIds: ["synthetic-payroll-batch"],
      rosterBatchIds: ["synthetic-roster-batch"],
      externalBatchIds: [], noExternalReason: "合成测试未取得外部三表"
    } });
    db.financeImportRecord.findMany.mockResolvedValue([
      { batchId: "synthetic-payroll-batch", kind: "PAYROLL", reviewStatus: "NEEDS_REVIEW", statement: null },
      { batchId: "synthetic-roster-batch", kind: "ROSTER", reviewStatus: "NEEDS_REVIEW", statement: null }
    ]);

    const status = await getMonthlyCloseStatus("2026-08", deps);

    expect(status.ready).toBe(false);
    expect(status.blockingWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("工资资料有 1 行尚未人工关联或确认"),
      expect.stringContaining("花名册有 1 行尚未人工关联")
    ]));
  });

  it("月结交付与同一正式批次绑定，重复生成复用交付记录且下载需要严格审计", async () => {
    const { db, tx, deps } = mockDeps();
    const rangeStart = new Date("2026-08-01T00:00:00+08:00");
    const rangeEnd = new Date("2026-09-01T00:00:00+08:00");
    const sourceHash = await currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: db as never });
    const bankBatch = { id: "synthetic-bank-batch", kind: "BANK_STATEMENT", rowCount: 2, periodStart: rangeStart, periodEnd: rangeEnd };
    db.financeImportBatch.findMany.mockResolvedValue([bankBatch]);
    db.financePeriodCoverage.findUnique.mockResolvedValue({ details: {
      bankAccounts: [{ alias: "合成基本户", batchIds: [bankBatch.id] }],
      payrollBatchIds: [], noPayrollReason: "合成测试不录入工资",
      rosterBatchIds: [], noRosterReason: "合成测试不更新花名册",
      externalBatchIds: [], noExternalReason: "合成测试未导入外部三表"
    } });
    const runRecord = (id: string) => ({
      id, status: "COMMITTED", periodStart: rangeStart, periodEnd: rangeEnd, sourceHash,
      summary: { allocationVersion: 2, snapshotVersion: "personal-v1", blockingIssues: [], lineCount: 1, recipientCount: 1, paymentCount: 1, refundCount: 0, personSnapshotCount: 0, firmSnapshotCount: 1, missingPayrollCount: 0, splitErrorCount: 0 },
      allocationLines: [{
        id: `${id}-line`, sourceKind: "PAYMENT", paymentId: "synthetic-payment", matterId: "synthetic-matter", targetUserId: null,
        grossAmount: new Prisma.Decimal("100.00"), channelAmount: new Prisma.Decimal("10.00"), firmAmount: new Prisma.Decimal("45.00"),
        sourceAmount: new Prisma.Decimal("7.00"), handlingAmount: new Prisma.Decimal("17.50"), coAmount: new Prisma.Decimal("10.50"),
        matter: { id: "synthetic-matter", internalCode: "SYN-001", title: "合成案件", primaryClient: { id: "synthetic-client" } },
        targetUser: null, payment: { id: "synthetic-payment", occurredAt: rangeStart },
        recipients: [{ id: `${id}-recipient`, userId: "synthetic-user-1", role: "SOURCE", amount: new Prisma.Decimal("7.00"), user: { id: "synthetic-user-1", name: "合成人员" } }]
      }],
      personPeriodSnapshots: [], firmPeriodSnapshot: { id: `${id}-firm` }
    });
    let currentRun = runRecord("run-1");
    const monthEnd = rangeEnd.getTime();
    db.financeCalculationRun.findFirst.mockImplementation(({ where }: { where: { periodEnd?: Date } }) => Promise.resolve(where.periodEnd?.getTime() === monthEnd ? currentRun : null));
    const runOne = currentRun;
    db.financeCalculationRun.findUnique.mockResolvedValue(runOne);
    db.financeCalculationRun.findMany.mockResolvedValue([runOne]);
    db.financeFirmPeriodSnapshot.findUnique.mockResolvedValue({ operatingResult: new Prisma.Decimal("0"), firmSalaryCost: new Prisma.Decimal("0"), firmSocialCost: new Prisma.Decimal("0"), firmFundCost: new Prisma.Decimal("0"), rentCost: new Prisma.Decimal("0"), officeCost: new Prisma.Decimal("0"), turnoverTaxCost: new Prisma.Decimal("0"), otherCost: new Prisma.Decimal("0") });
    const writeFile = deps.storage!.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockResolvedValue("finance-artifacts/202609/test.bin");
    const created = await generateMonthlyClose("2026-08", deps);
    expect(created).toHaveLength(5);
    expect(writeFile).toHaveBeenCalledTimes(5);
    expect((db.financeArtifact.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ where: { runId: "run-1" } });
    expect(tx.financeMonthlyClose.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ period: "2026-08", revision: 1, runId: "run-1", sourceHash }) }));

    const existing = Array.from({ length: 5 }, (_, index) => ({ id: `artifact-${index}`, runId: "run-1", kind: index === 4 ? "ZIP" : "WAGE" }));
    db.financeArtifact.findMany.mockResolvedValue(existing);
    const second = await generateMonthlyClose("2026-08", deps);
    expect(second).toBe(existing);
    expect(writeFile).toHaveBeenCalledTimes(5);

    db.financeArtifact.findMany.mockResolvedValue([]);
    tx.financeMonthlyClose.findFirst.mockResolvedValue({ revision: 1 });
    currentRun = runRecord("run-2");
    const runTwo = currentRun;
    db.financeCalculationRun.findUnique.mockResolvedValue(runTwo);
    db.financeCalculationRun.findMany.mockResolvedValue([runTwo]);
    const revised = await generateMonthlyClose("2026-08", deps);
    expect(revised).toHaveLength(5);
    expect(writeFile).toHaveBeenCalledTimes(10);
    expect(tx.financeMonthlyClose.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ period: "2026-08", revision: 2, runId: "run-2" }) }));

    db.financeArtifact.findUnique.mockResolvedValue({ id: "artifact-4", fileName: "LawLink-月结-2026-08.zip", storagePath: "finance-artifacts/202609/test.bin", kind: "ZIP", run: { status: "COMMITTED" } });
    (deps.storage!.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from("zip"));
    const audited: unknown[] = [];
    const download = await downloadFinanceArtifact("artifact-4", { ...deps, auditStrict: async (entry) => { audited.push(entry); } });
    expect(download.fileName).toBe("LawLink-月结-2026-08.zip");
    expect(download.bytes.toString()).toBe("zip");
    expect(audited).toHaveLength(1);
  });
});
