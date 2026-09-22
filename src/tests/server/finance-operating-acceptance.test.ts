import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";
import { parseFinanceWorkbook } from "@/lib/finance/import-parser";
import { rankPaymentCandidates } from "@/lib/finance/internal-matching";
import { calculateAllocation } from "@/lib/finance/internal-rules";
import { buildFirmOperatingResult, buildPersonalDoubleBalance } from "@/lib/finance/internal-accounting";
import { commitFinanceImport } from "@/server/finance/internal-imports";
import { getInternalFinanceSummary } from "@/server/finance/internal-reports";
import { generateMonthlyClose, getMonthlyCloseStatus } from "@/server/finance/monthly-close";

vi.mock("@/server/finance/internal-export", () => ({
  buildFinanceWorkbook: vi.fn().mockResolvedValue(Buffer.from("synthetic-workbook"))
}));

const financeActor = { id: "synthetic-user-2", role: "FINANCE" } as const;

describe("内部财务合成闭环验收", () => {
  it("排除待确认收款，贯通导入、认领、分配、双余额、经营结果与月结批次", async () => {
    const fixture = makeSyntheticFinanceFixture();
    const csv = [
      "日期,金额,对方名称,摘要,流水号",
      "2026-08-01,100000.00,合成客户,合成律师费,synthetic-ref-1"
    ].join("\n");
    const parsed = await parseFinanceWorkbook(Buffer.from(csv, "utf8"), "synthetic-bank.csv", "BANK_STATEMENT");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);

    const suggestions = rankPaymentCandidates(parsed.rows[0], [{
      paymentId: fixture.confirmedPayment.id,
      matterId: fixture.matter.id,
      feeEntryId: fixture.confirmedPayment.feeEntryId,
      occurredAt: fixture.confirmedPayment.occurredAt,
      amount: fixture.confirmedPayment.amount,
      moneyKind: "LAWYER_FEE",
      confirmState: "CONFIRMED",
      externalReference: "synthetic-ref-1",
      alreadyUsed: false
    }]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ paymentId: fixture.confirmedPayment.id, score: 100, autoConfirm: true });

    const tx = {
      financeImportBatch: { create: vi.fn().mockResolvedValue({ id: "synthetic-batch-1" }) },
      financeSourceFile: { create: vi.fn().mockResolvedValue({ id: "synthetic-file-1" }) },
      financeSourceRow: { createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([{ id: "synthetic-source-row-1" }]) },
      financeReconciliationCase: { createMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "synthetic-audit-1" }) }
    };
    const importDb = {
      financeImportBatch: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "synthetic-batch-1", status: "COMMITTED" })
      },
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
    };
    const storage = { writeFile: vi.fn().mockResolvedValue("finance-imports/synthetic.bin"), readFile: vi.fn(), deleteFile: vi.fn() };
    const firstImport = await commitFinanceImport({ fileName: "synthetic-bank.csv", kind: "BANK_STATEMENT", bytes: Buffer.from(csv, "utf8") }, { db: importDb as never, storage, actorId: financeActor.id });
    const secondImport = await commitFinanceImport({ fileName: "synthetic-bank.csv", kind: "BANK_STATEMENT", bytes: Buffer.from(csv, "utf8") }, { db: importDb as never, storage, actorId: financeActor.id });
    expect(firstImport).toEqual({ batchId: "synthetic-batch-1", duplicate: false });
    expect(secondImport).toEqual({ batchId: "synthetic-batch-1", duplicate: true });
    expect(tx.financeSourceRow.createMany).toHaveBeenCalledTimes(1);

    const allocation = calculateAllocation({ gross: "90000.00", channelRate: "0.10", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.45", coRate: "0.35" });
    expect(allocation.channel.plus(allocation.firm).plus(allocation.source).plus(allocation.handling).plus(allocation.co).toFixed(2)).toBe("90000.00");

    const personal = buildPersonalDoubleBalance({ openingDistributable: "0.00", openingReserve: "0.00", earnedIncome: allocation.source.plus(allocation.handling).plus(allocation.co).toFixed(2), selfCostDue: fixture.expense.amount, selfFundingIn: "0.00", withdrawn: "0.00", partnerTaxAdvance: "0.00", unsettledHold: "0.00" });
    expect(personal.reserveGap).toBe("24000.00");

    const firmResult = buildFirmOperatingResult({ feeRevenue: "90000.00", channel: allocation.channel.toFixed(2), lawyer: allocation.source.plus(allocation.handling).plus(allocation.co).toFixed(2), firmSalary: "0.00", firmSocial: "0.00", rent: "0.00", taxes: "0.00", incomeWithdrawal: fixture.capitalFlow.amount, partnerTaxAdvance: "0.00" });
    expect(firmResult.operatingResult).toBe("36450.00");

    const reportLine = {
      id: "synthetic-line-1",
      runId: "synthetic-run-1",
      paymentId: fixture.confirmedPayment.id,
      matterId: fixture.matter.id,
      targetUserId: fixture.users[0].id,
      grossAmount: new Prisma.Decimal("90000.00"),
      channelAmount: allocation.channel,
      firmAmount: allocation.firm,
      sourceAmount: allocation.source,
      handlingAmount: allocation.handling,
      coAmount: allocation.co,
      matter: { id: fixture.matter.id, internalCode: fixture.matter.internalCode, title: fixture.matter.title, primaryClient: { id: fixture.client.id } },
      targetUser: { id: fixture.users[0].id, name: fixture.users[0].name },
      payment: { id: fixture.confirmedPayment.id, occurredAt: new Date("2026-08-01T00:00:00+08:00") }
    };
    const reportDb = { financeCalculationRun: { findMany: vi.fn().mockResolvedValue([{ id: "synthetic-run-1", status: "COMMITTED", periodStart: new Date("2026-08-01T00:00:00+08:00"), periodEnd: new Date("2026-09-01T00:00:00+08:00"), allocationLines: [reportLine] }]) } };
    const summary = await getInternalFinanceSummary({ start: new Date("2026-08-01T00:00:00+08:00"), end: new Date("2026-09-01T00:00:00+08:00"), groupBy: "ALL" }, { db: reportDb as never, actor: financeActor });
    expect(summary.calculationRunId).toBe("synthetic-run-1");
    expect(summary.persons[0].calculationRunId).toBe(summary.firm.calculationRunId);
    expect(summary.total).toBe("90000.00");
    expect(summary.projects[0].lines).toHaveLength(1);

    const closeTx = {
      financeMonthlyClose: { upsert: vi.fn().mockResolvedValue({ id: "synthetic-close-1" }) },
      financeArtifact: { create: vi.fn().mockImplementation(({ data }: { data: { id?: string; runId: string; sha256: string } }) => Promise.resolve({ id: data.id ?? `artifact-${data.runId}-${data.sha256.slice(0, 4)}` })) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "synthetic-audit-close" }) }
    };
    const closeDb = {
      financeImportBatch: { findMany: vi.fn().mockResolvedValue([{ kind: "BANK_STATEMENT", rowCount: 1 }]) },
      financeReconciliationCase: { count: vi.fn().mockResolvedValue(0) },
      financeCalculationRun: { findFirst: vi.fn().mockResolvedValue({ id: "synthetic-run-1", sourceHash: "synthetic-source-hash", summary: {} }) },
      financeMonthlyClose: { findUnique: vi.fn().mockResolvedValue(null) },
      financeArtifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (value: typeof closeTx) => Promise<unknown>) => callback(closeTx))
    };
    const status = await getMonthlyCloseStatus("2026-08", { db: closeDb as never, actor: financeActor });
    expect(status).toMatchObject({ ready: true, runId: "synthetic-run-1", sourceHash: "synthetic-source-hash" });
    const artifacts = await generateMonthlyClose("2026-08", { db: closeDb as never, actor: financeActor, storage: { writeFile: vi.fn().mockResolvedValue("finance-artifacts/synthetic.bin"), readFile: vi.fn(), deleteFile: vi.fn() } });
    expect(artifacts).toHaveLength(5);
    expect(closeTx.financeMonthlyClose.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ runId: "synthetic-run-1", sourceHash: "synthetic-source-hash" }) }));
    expect(closeTx.financeArtifact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runId: "synthetic-run-1" }) }));
    expect(fixture.pendingReceipt.confirmState).toBe("PENDING");
  });
});
