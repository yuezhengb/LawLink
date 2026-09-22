import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildFinanceWorkbook } from "@/server/finance/internal-export";
import { getInternalFinanceSummary, type FinanceReportsDependencies } from "@/server/finance/internal-reports";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;
const start = new Date("2026-08-01T00:00:00+08:00");
const end = new Date("2026-09-01T00:00:00+08:00");

function committedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-committed",
    periodStart: start,
    periodEnd: end,
    sourceHash: "hash-committed",
    status: "COMMITTED",
    calculatedAt: new Date("2026-09-01T01:00:00Z"),
    allocationLines: [
      {
        id: "line-1",
        paymentId: "synthetic-payment-1",
        matterId: "synthetic-matter-1",
        targetUserId: "synthetic-user-1",
        ruleVersionId: "rule-version-1",
        grossAmount: new Prisma.Decimal("100.00"),
        channelAmount: new Prisma.Decimal("10.00"),
        firmAmount: new Prisma.Decimal("40.50"),
        sourceAmount: new Prisma.Decimal("9.90"),
        handlingAmount: new Prisma.Decimal("22.28"),
        coAmount: new Prisma.Decimal("17.32"),
        matter: { internalCode: "SYN-2026-001", title: "合成案件", primaryClient: { id: "synthetic-client-1", name: "合成客户" } },
        targetUser: { id: "synthetic-user-1", name: "合成人员一" },
        payment: { occurredAt: new Date("2026-08-01T00:00:00+08:00") }
      }
    ],
    ...overrides
  };
}

function mockDeps() {
  const db = {
    financeCalculationRun: { findMany: vi.fn() }
  };
  return { db, deps: { db: db as never, actor } satisfies FinanceReportsDependencies };
}

describe("内部财务三视角报表", () => {
  it("只汇总 COMMITTED 计算批次", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([
      committedRun(),
      committedRun({ id: "run-preview", status: "PREVIEW", sourceHash: "hash-preview", allocationLines: [{ ...committedRun().allocationLines[0], grossAmount: new Prisma.Decimal("999.00") }] })
    ]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "LAWYER" }, deps);

    expect(result.total).toBe("100.00");
    expect(result.calculationRunId).toBe("run-committed");
  });

  it("三视角使用同一计算批次并可穿透到分配行", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);

    const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" }, deps);

    expect(result.persons[0].calculationRunId).toBe(result.firm.calculationRunId);
    expect(result.projects[0].lines[0].sourcePaymentId).toBe("synthetic-payment-1");
  });

  it("工作簿页签固定且不输出完整客户名称或账号", async () => {
    const { db, deps } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([committedRun()]);

    const bytes = await buildFinanceWorkbook({ start, end, groupBy: "ALL" }, deps);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "人员透支表",
      "客户项目归属",
      "律所经营成果",
      "来源与对账",
      "调整审计"
    ]);
    expect(bytes.toString("utf8")).not.toContain("合成客户");
  });

  it("没有财务查看权限的自定义角色被拒绝", async () => {
    const { db } = mockDeps();
    db.financeCalculationRun.findMany.mockResolvedValue([]);
    await expect(
      getInternalFinanceSummary({ start, end, groupBy: "ALL" }, { db: db as never, actor: { id: "user-1", role: "CUSTOM", rolePermissions: [] } })
    ).rejects.toThrow("无财务报表权限");
  });
});
