import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { describe, expect, it, vi } from "vitest";
import {
  buildLawyerSettlementWorkbook,
  buildLawyerSettlementZip,
  type FinanceSettlementActor,
  type FinanceSettlementDependencies
} from "@/server/finance/personal-settlement";

function snapshot(userId: string, name: string) {
  return {
    userId, period: "2026-08", user: { name },
    openingDistributable: "100.00", openingReserve: "50.00", earned: "300.00", selfCostDue: "20.00",
    selfFundingIn: "10.00", selfFundingUsed: "5.00", selfCostChargedToIncome: "15.00", withdrawn: "25.00",
    partnerTaxAdvance: "0.00", unsettledHold: "0.00", distributableEnd: "360.00", reserveEnd: "55.00", reserveGap: "0.00"
  };
}

function dependencies() {
  const auditStrict = vi.fn().mockResolvedValue(undefined);
  const db = {
    financeCalculationRun: { findUnique: vi.fn().mockResolvedValue({ id: "run-committed", status: "COMMITTED", periodStart: new Date("2026-08-01T00:00:00+08:00"), periodEnd: new Date("2026-09-01T00:00:00+08:00"), sourceHash: "synthetic-source-hash" }) },
    financePersonPeriodSnapshot: {
      findUnique: vi.fn(async ({ where }: { where: { runId_userId: { userId: string } } }) => where.runId_userId.userId === "person-1" ? snapshot("person-1", "合成人员一") : snapshot("person-2", "不得进入他人文件")),
      findMany: vi.fn().mockResolvedValue([snapshot("person-1", "合成人员一"), snapshot("person-2", "合成人员二")])
    },
    financeAllocationLine: {
      findMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
        const userFilter = JSON.stringify(where.OR);
        const target = userFilter.includes("person-1") ? "person-1" : "person-2";
        return [{
          id: `line-${target}`, targetUserId: null, sourceKind: "PAYMENT", refundLinkId: null, sourceOccurredAt: new Date("2026-08-12T00:00:00+08:00"),
          grossAmount: "100.00", channelAmount: "10.00", firmAmount: "40.00", sourceAmount: "20.00", handlingAmount: "20.00", coAmount: "10.00",
          matter: { internalCode: `CASE-${target}`, title: target === "person-1" ? "本人合成案件" : "他人案件不得进入" },
          payment: { id: `payment-${target}` },
          recipients: [{ userId: target, role: "SOURCE", amount: "20.00" }]
        }];
      })
    }
  };
  return { db, auditStrict, deps: { db: db as never, auditStrict } satisfies FinanceSettlementDependencies };
}

describe("律师个人结算交付", () => {
  it("个人工作簿只含该律师快照和分配明细，不混入另一人的信息", async () => {
    const { db, auditStrict, deps } = dependencies();
    const bytes = await buildLawyerSettlementWorkbook("run-committed", "person-1", { id: "person-1", role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "OWN" }] }, deps);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    const workbookText = workbook.worksheets.flatMap((sheet) => sheet.getSheetValues().flat().map(String)).join("|");

    expect(workbook.getWorksheet("个人余额快照")?.rowCount).toBeGreaterThan(2);
    expect(workbookText).toContain("CASE-person-1");
    expect(workbookText).not.toContain("不得进入他人文件");
    expect(workbookText).not.toContain("他人案件不得进入");
    expect(db.financeAllocationLine.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: "run-committed", OR: expect.any(Array) }) }));
    expect(auditStrict).toHaveBeenCalledOnce();
    expect(JSON.stringify(auditStrict.mock.calls[0][0])).not.toContain("合成人员");
  });

  it("全所 ZIP 每位律师一个独立 XLSX，并包含来源指纹清单", async () => {
    const { deps } = dependencies();
    const bytes = await buildLawyerSettlementZip("run-committed", { id: "finance-user", role: "FINANCE" }, deps);
    const zip = new PizZip(bytes);
    const entries = Object.keys(zip.files).filter((name) => name.endsWith(".xlsx"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toContain("合成人员");
    expect(zip.file("MANIFEST.txt")?.asText()).toContain("synthetic-source-hash");
    for (const name of entries) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(zip.file(name)!.asNodeBuffer() as never);
      const text = workbook.worksheets.flatMap((sheet) => sheet.getSheetValues().flat().map(String)).join("|");
      if (name.includes("rson-1")) {
        expect(text).toContain("CASE-person-1");
        expect(text).not.toContain("CASE-person-2");
        expect(text).not.toContain("合成人员二");
      } else {
        expect(text).toContain("CASE-person-2");
        expect(text).not.toContain("CASE-person-1");
        expect(text).not.toContain("合成人员一");
      }
    }
  });

  it("个人范围禁止导出他人，不存在或未提交的批次拒绝", async () => {
    const { db, deps } = dependencies();
    const ownActor: FinanceSettlementActor = { id: "person-1", role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "OWN" }] };
    await expect(buildLawyerSettlementWorkbook("run-committed", "person-2", ownActor, deps)).rejects.toThrow("无权导出其他人员结算");
    expect(db.financePersonPeriodSnapshot.findUnique).not.toHaveBeenCalled();

    db.financeCalculationRun.findUnique.mockResolvedValueOnce({ id: "run-preview", status: "PREVIEW", periodStart: new Date(), periodEnd: new Date(), sourceHash: "h" });
    await expect(buildLawyerSettlementWorkbook("run-preview", "person-1", { id: "finance-user", role: "FINANCE" }, deps)).rejects.toThrow("正式财务批次不存在或未提交");
  });
});
