import { describe, expect, it, vi } from "vitest";
import {
  getInternalAccounting,
  saveCapitalFlow,
  savePartnerTaxRecord,
  savePayrollFact,
  type FinanceAccountingDependencies
} from "@/server/finance/internal-accounting-actions";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financePayrollFact: { upsert: vi.fn().mockResolvedValue({ id: "payroll-1" }) },
    financePartnerTaxRecord: { create: vi.fn().mockResolvedValue({ id: "tax-1" }) },
    financeCapitalFlow: { create: vi.fn().mockResolvedValue({ id: "capital-1" }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) }
  };
  const db = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: "synthetic-user-1" }) },
    financePayrollFact: { findMany: vi.fn().mockResolvedValue([]) },
    financePartnerTaxRecord: { findMany: vi.fn().mockResolvedValue([]) },
    financeCapitalFlow: { findMany: vi.fn().mockResolvedValue([]) },
    financePersonLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    financeAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const deps: FinanceAccountingDependencies = { db: db as never, actor };
  return { db, tx, deps };
}

describe("内部工资、税款与资本流水", () => {
  it("工资事实按人员和期间 upsert，并保留来源批次", async () => {
    const { tx, deps } = mockDeps();
    await expect(savePayrollFact({
      userId: "synthetic-user-1",
      period: "2026-08",
      grossSalary: "15000.00",
      commission: "1000.00",
      socialPersonal: "500.00",
      socialCompany: "500.00",
      fundPersonal: "300.00",
      fundCompany: "300.00",
      incomeTax: "500.00",
      otherDeduction: "0.00",
      reimbursement: "0.00",
      actualPaymentPeriod: "2026-08",
      sourceBatchId: "batch-payroll"
    }, deps)).resolves.toEqual({ id: "payroll-1" });
    expect(tx.financePayrollFact.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_period: { userId: "synthetic-user-1", period: "2026-08" } } }));
  });

  it("合伙人税款和资本流单独记账，不混入工资事实", async () => {
    const { tx, deps } = mockDeps();
    await expect(savePartnerTaxRecord({
      userId: "synthetic-user-1",
      period: "2026-08",
      estimatedTax: "2000.00",
      firmAdvance: "1000.00",
      personallyPaid: "0.00",
      phase: "ADVANCED",
      evidenceRef: "tax-proof-1"
    }, deps)).resolves.toEqual({ id: "tax-1" });
    await expect(saveCapitalFlow({
      investorId: "synthetic-user-2",
      period: "2026-08",
      amount: "50000.00",
      kind: "CAPITAL_IN",
      throughPartnerId: "synthetic-user-2",
      remarks: "合成资本"
    }, deps)).resolves.toEqual({ id: "capital-1" });
    expect(tx.financePayrollFact.upsert).not.toHaveBeenCalled();
    expect(tx.financePartnerTaxRecord.create).toHaveBeenCalled();
    expect(tx.financeCapitalFlow.create).toHaveBeenCalled();
  });

  it("内账查询按期间返回四类事实，不默认连接真实库", async () => {
    const { db, deps } = mockDeps();
    db.financePayrollFact.findMany.mockResolvedValue([{ id: "payroll-1", amount: "15000.00" }]);
    const result = await getInternalAccounting({ period: "2026-08" }, deps);
    expect(result).toMatchObject({ period: "2026-08", payrollFacts: [{ id: "payroll-1" }], taxRecords: [], capitalFlows: [], ledgerEntries: [], adjustments: [] });
  });
});
