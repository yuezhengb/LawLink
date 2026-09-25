import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { listFinanceImportReviews, resolveFinanceImportRecord } from "@/server/finance/internal-import-review";

const actor = { id: "synthetic-finance-user", role: "FINANCE" } as const;

function reviewFixture(kind: "PAYROLL" | "ROSTER" | "EXTERNAL_THREE_STATEMENTS" = "PAYROLL") {
  let record: Record<string, unknown> = {
    id: "synthetic-import-record",
    batchId: "synthetic-import-batch",
    sourceSheet: "律师工资",
    sourceRow: 2,
    kind,
    period: "2026-08",
    asOfDay: new Date("2026-08-31T00:00:00+08:00"),
    roleLabel: kind === "ROSTER" ? "律师" : null,
    statement: kind === "EXTERNAL_THREE_STATEMENTS" ? "INCOME" : null,
    item: kind === "EXTERNAL_THREE_STATEMENTS" ? "合成收入项目" : null,
    amount: kind === "EXTERNAL_THREE_STATEMENTS" ? new Prisma.Decimal("100.00") : null,
    declaredSalary: kind === "PAYROLL" ? new Prisma.Decimal("15000.00") : null,
    actualCashPaid: kind === "PAYROLL" ? new Prisma.Decimal("12000.00") : null,
    selfCostDue: kind === "PAYROLL" ? new Prisma.Decimal("800.00") : null,
    resolvedUserId: null,
    reviewStatus: "NEEDS_REVIEW",
    batch: { status: "COMMITTED" }
  };
  const tx = {
    financeImportRecord: {
      findUnique: vi.fn(async () => record),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        record = { ...record, ...data };
        return { id: record.id, reviewStatus: record.reviewStatus, resolvedUserId: record.resolvedUserId };
      })
    },
    financePayrollFact: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "synthetic-payroll-fact" })
    },
    financePayrollFactRevision: { create: vi.fn().mockResolvedValue({ id: "synthetic-payroll-revision" }) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "synthetic-lawyer", active: true }), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "synthetic-audit" }) }
  };
  const db = {
    financeImportRecord: { findUnique: vi.fn(async () => record) },
    financePayrollFact: { findUnique: vi.fn().mockResolvedValue({ id: "synthetic-payroll-fact" }) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "synthetic-lawyer", active: true }) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  return { db, tx, getRecord: () => record };
}

describe("律所类型化财务资料人工复核", () => {
  it("工资记录按财务指定人员入账，承担口径未复核前不放行", async () => {
    const { db, tx } = reviewFixture("PAYROLL");

    const result = await resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", { db: db as never, actor });

    expect(result).toMatchObject({ kind: "PAYROLL", reviewStatus: "RESOLVED", payrollFactId: "synthetic-payroll-fact", duplicate: false });
    expect(tx.financePayrollFact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        userId: "synthetic-lawyer", period: "2026-08", grossSalary: "15000.00", actualCashPaid: "12000.00",
        selfCostDue: "800.00", sourceBatchId: "synthetic-import-batch", treatmentReviewed: false
      })
    }));
    expect(tx.financePayrollFactRevision.create).toHaveBeenCalledOnce();
    expect(tx.financeImportRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: { resolvedUserId: "synthetic-lawyer", reviewStatus: "RESOLVED" } }));
  });

  it("同一条工资记录重复确认幂等，不重复新增工资修订", async () => {
    const { db, tx } = reviewFixture("PAYROLL");

    await resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", { db: db as never, actor });
    const second = await resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", { db: db as never, actor });

    expect(second).toMatchObject({ duplicate: true, payrollFactId: "synthetic-payroll-fact" });
    expect(tx.financePayrollFact.upsert).toHaveBeenCalledOnce();
    expect(tx.financePayrollFactRevision.create).toHaveBeenCalledOnce();
  });

  it("本期已有工资事实时不静默覆盖", async () => {
    const { db, tx } = reviewFixture("PAYROLL");
    tx.financePayrollFact.findUnique.mockResolvedValue({ id: "synthetic-existing-payroll" });

    await expect(resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", { db: db as never, actor }))
      .rejects.toThrow("该人员本期已有工资事实");
    expect(tx.financePayrollFact.upsert).not.toHaveBeenCalled();
    expect(tx.financeImportRecord.update).not.toHaveBeenCalled();
  });

  it("花名册只记录人工人员关联，不修改 User 资料", async () => {
    const { db, tx } = reviewFixture("ROSTER");

    const result = await resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", { db: db as never, actor });

    expect(result).toMatchObject({ kind: "ROSTER", reviewStatus: "RESOLVED", duplicate: false });
    expect(tx.financeImportRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: { resolvedUserId: "synthetic-lawyer", reviewStatus: "RESOLVED" } }));
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.financePayrollFact.upsert).not.toHaveBeenCalled();
  });

  it("外部三表只允许核对标记，普通律师不能执行复核", async () => {
    const external = reviewFixture("EXTERNAL_THREE_STATEMENTS");
    const result = await resolveFinanceImportRecord("synthetic-import-record", null, { db: external.db as never, actor });
    expect(result).toMatchObject({ kind: "EXTERNAL_THREE_STATEMENTS", reviewStatus: "RESOLVED", duplicate: false });

    const restricted = reviewFixture("ROSTER");
    await expect(resolveFinanceImportRecord("synthetic-import-record", "synthetic-lawyer", {
      db: restricted.db as never,
      actor: { id: "synthetic-lawyer", role: "LAWYER" }
    })).rejects.toThrow("无权复核财务资料");
    expect(restricted.db.$transaction).not.toHaveBeenCalled();
  });

  it("复核列表在财务读取范围返回来源姓名，不生成姓名摘要", async () => {
    const db = {
      financeImportRecord: { findMany: vi.fn().mockResolvedValue([{
        id: "synthetic-import-record", batchId: "synthetic-import-batch", sourceSheet: "工资明细", sourceRow: 2, kind: "PAYROLL",
        period: "2026-08", asOfDay: null, roleLabel: null, statement: null, item: null, amount: null, displayName: "合成人员甲",
        declaredSalary: new Prisma.Decimal("15000.00"), actualCashPaid: new Prisma.Decimal("12000.00"),
        selfCostDue: new Prisma.Decimal("800.00"), resolvedUserId: "synthetic-lawyer", reviewStatus: "RESOLVED",
        batch: { fileName: "synthetic-payroll.csv" }, resolvedUser: { name: "合成人员" }
      }]) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: "synthetic-lawyer", name: "合成人员", role: "LAWYER" }]) }
    };

    const result = await listFinanceImportReviews({ db: db as never, actor });

    expect(result.records[0]).toMatchObject({ sourceSheet: "工资明细", sourceRow: 2, displayName: "合成人员甲", declaredSalary: "15000.00", resolvedUserName: "合成人员" });
    expect(result.records[0]).not.toHaveProperty("displayNameDigest");
  });

  it("OWN 读取范围只列出本人导入批次且不暴露全所人员选项", async () => {
    const db = {
      financeImportRecord: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn() }
    };

    await listFinanceImportReviews({
      db: db as never,
      actor: { id: "synthetic-importer", role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "OWN" }] }
    });

    expect(db.financeImportRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { batch: { status: "COMMITTED", createdById: "synthetic-importer" } }
    }));
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
