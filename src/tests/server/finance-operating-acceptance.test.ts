import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import PizZip from "pizzip";
import { describe, expect, it, vi } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";
import { parseFinanceWorkbook } from "@/lib/finance/import-parser";
import { rankPaymentCandidates } from "@/lib/finance/internal-matching";
import { calculateAllocation } from "@/lib/finance/internal-rules";
import { buildFirmOperatingResult, buildPersonalDoubleBalance } from "@/lib/finance/internal-accounting";
import { commitFinanceImport } from "@/server/finance/internal-imports";
import { getInternalFinanceSummary } from "@/server/finance/internal-reports";
import { generateMonthlyClose, getMonthlyCloseStatus } from "@/server/finance/monthly-close";
import { currentAllocationSourceHash } from "@/server/finance/internal-allocation";

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
      payment: { id: fixture.confirmedPayment.id, occurredAt: new Date("2026-08-01T00:00:00+08:00") },
      recipients: [
        { id: "synthetic-recipient-source", userId: fixture.users[0].id, role: "SOURCE", shareRate: new Prisma.Decimal("1"), amount: allocation.source, user: { id: fixture.users[0].id, name: fixture.users[0].name } },
        { id: "synthetic-recipient-handling", userId: fixture.users[0].id, role: "HANDLING", shareRate: new Prisma.Decimal("1"), amount: allocation.handling, user: { id: fixture.users[0].id, name: fixture.users[0].name } },
        { id: "synthetic-recipient-co", userId: fixture.users[1].id, role: "CO", shareRate: new Prisma.Decimal("1"), amount: allocation.co, user: { id: fixture.users[1].id, name: fixture.users[1].name } }
      ]
    };
    const reportDb = {
      financeCalculationRun: { findMany: vi.fn().mockResolvedValue([{ id: "synthetic-run-1", status: "COMMITTED", sourceHash: "synthetic-source-hash", periodStart: new Date("2026-08-01T00:00:00+08:00"), periodEnd: new Date("2026-09-01T00:00:00+08:00"), allocationLines: [reportLine] }]) },
      financeFirmPeriodSnapshot: { findUnique: vi.fn().mockResolvedValue(null) },
      billing: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceRequest: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
      payment: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const summary = await getInternalFinanceSummary({ start: new Date("2026-08-01T00:00:00+08:00"), end: new Date("2026-09-01T00:00:00+08:00"), groupBy: "ALL" }, { db: reportDb as never, actor: financeActor });
    expect(summary.calculationRunId).toBe("synthetic-run-1");
    expect(summary.persons[0].calculationRunId).toBe(summary.firm.calculationRunId);
    expect(summary.total).toBe("90000.00");
    expect(summary.projects[0].lines).toHaveLength(1);

    const closeTx = {
      financeMonthlyClose: { create: vi.fn().mockResolvedValue({ id: "synthetic-close-1" }), findFirst: vi.fn().mockResolvedValue(null) },
      financeArtifact: { create: vi.fn().mockImplementation(({ data }: { data: { id?: string; runId: string; sha256: string } }) => Promise.resolve({ id: data.id ?? `artifact-${data.runId}-${data.sha256.slice(0, 4)}` })) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "synthetic-audit-close" }) }
    };
    const start = new Date("2026-08-01T00:00:00+08:00");
    const end = new Date("2026-09-01T00:00:00+08:00");
    const bankBatch = { id: "synthetic-batch-1", kind: "BANK_STATEMENT", rowCount: 1, periodStart: start, periodEnd: end };
    const closeDb: Record<string, unknown> = {
      financeImportBatch: { findMany: vi.fn().mockResolvedValue([bankBatch]) },
      financeReconciliationCase: { count: vi.fn().mockResolvedValue(0) },
      financeCalculationRun: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
      financeMonthlyClose: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
      financePeriodCoverage: { findUnique: vi.fn().mockResolvedValue({ details: {
        bankAccounts: [{ alias: "合成基本户", batchIds: [bankBatch.id] }],
        payrollBatchIds: [], noPayrollReason: "合成验收不录入工资",
        rosterBatchIds: [], noRosterReason: "合成验收不更新花名册",
        externalBatchIds: [], noExternalReason: "合成验收不导入外部三表"
      } }) },
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
      financeAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
      financeImportRecord: { findMany: vi.fn().mockResolvedValue([]) },
      financeFirmPeriodSnapshot: { findUnique: vi.fn().mockResolvedValue({
        operatingResult: new Prisma.Decimal("36450.00"), firmSalaryCost: new Prisma.Decimal("0"), firmSocialCost: new Prisma.Decimal("0"), firmFundCost: new Prisma.Decimal("0"), rentCost: new Prisma.Decimal("0"), officeCost: new Prisma.Decimal("0"), turnoverTaxCost: new Prisma.Decimal("0"), otherCost: new Prisma.Decimal("0")
      }) },
      financePersonPeriodSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
      financeArtifact: { findMany: vi.fn().mockResolvedValue([]) },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
      billing: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceRequest: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (value: typeof closeTx) => Promise<unknown>) => callback(closeTx))
    };
    const currentSourceHash = await currentAllocationSourceHash({ periodStart: "2026-08-01", periodEnd: "2026-09-01" }, { db: closeDb as never });
    const committedRun = {
      id: "synthetic-run-1", status: "COMMITTED", periodStart: start, periodEnd: end, sourceHash: currentSourceHash,
      summary: { allocationVersion: 2, snapshotVersion: "personal-v1", blockingIssues: [], lineCount: 1, recipientCount: 3, paymentCount: 1, refundCount: 0, personSnapshotCount: 0, firmSnapshotCount: 1, missingPayrollCount: 0, splitErrorCount: 0 },
      allocationLines: [reportLine], personPeriodSnapshots: [], firmPeriodSnapshot: { id: "synthetic-firm-snapshot" }
    };
    const monthEnd = end.getTime();
    (closeDb.financeCalculationRun as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockImplementation(({ where }: { where: { periodEnd?: Date } }) => Promise.resolve(where.periodEnd?.getTime() === monthEnd ? committedRun : null));
    (closeDb.financeCalculationRun as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(committedRun);
    (closeDb.financeCalculationRun as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([committedRun]);
    const status = await getMonthlyCloseStatus("2026-08", { db: closeDb as never, actor: financeActor });
    expect(status).toMatchObject({ ready: true, runId: "synthetic-run-1", sourceHash: currentSourceHash });
    const storedBytes: Buffer[] = [];
    const writeFile = vi.fn(async (_folder: string, bytes: Buffer) => { storedBytes.push(Buffer.from(bytes)); return `finance-artifacts/synthetic-${storedBytes.length}.bin`; });
    const artifacts = await generateMonthlyClose("2026-08", { db: closeDb as never, actor: financeActor, storage: { writeFile, readFile: vi.fn(), deleteFile: vi.fn() } });
    expect(artifacts).toHaveLength(5);
    expect(new Set(storedBytes.slice(0, 4).map((bytes) => createHash("sha256").update(bytes).digest("hex"))).size).toBe(4);
    const packageZip = new PizZip(storedBytes[4]);
    expect(packageZip.file(/\.xlsx$/)).toHaveLength(4);
    expect(closeTx.financeMonthlyClose.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revision: 1, runId: "synthetic-run-1", sourceHash: currentSourceHash }) }));
    expect(closeTx.financeArtifact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runId: "synthetic-run-1" }) }));
    expect(fixture.pendingReceipt.confirmState).toBe("PENDING");
  });
});
