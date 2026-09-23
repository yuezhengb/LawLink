import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  getInternalAccounting,
  savePersonalLedgerEntry,
  saveCapitalFlow,
  saveOpeningBalance,
  savePartnerTaxRecord,
  savePayrollFact,
  type FinanceAccountingDependencies
} from "@/server/finance/internal-accounting-actions";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financePayrollFact: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "payroll-1" })
    },
    financePayrollFactRevision: { create: vi.fn().mockResolvedValue({ id: "payroll-revision-1" }) },
    financeOpeningBalance: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "opening-balance-1" })
    },
    financePersonLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "personal-ledger-1" })
    },
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

  it("工资、扣款和承担成本金额都不能为负数", async () => {
    const { tx, deps } = mockDeps();
    await expect(savePayrollFact({
      userId: "synthetic-user-1", period: "2026-08", grossSalary: "-1.00", commission: "0.00",
      socialPersonal: "0.00", socialCompany: "0.00", fundPersonal: "0.00", fundCompany: "0.00",
      incomeTax: "0.00", otherDeduction: "0.00", reimbursement: "0.00"
    }, deps)).rejects.toThrow("工资事实不完整");
    expect(tx.financePayrollFact.upsert).not.toHaveBeenCalled();
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

  it("期初余额必须由财务带凭据确认，且确认后不能覆盖", async () => {
    const { db, tx, deps } = mockDeps();
    await expect(saveOpeningBalance({
      userId: "synthetic-user-1", firstPeriod: "2026-08", distributable: "0.00", reserve: "0.00", evidenceRef: "synthetic-opening-proof"
    }, deps)).resolves.toEqual({ id: "opening-balance-1" });
    expect(tx.financeOpeningBalance.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "synthetic-user-1", firstPeriod: "2026-08", evidenceRef: "synthetic-opening-proof", confirmedById: actor.id })
    }));

    tx.financeOpeningBalance.findUnique.mockResolvedValue({ id: "opening-balance-1" });
    await expect(saveOpeningBalance({
      userId: "synthetic-user-1", firstPeriod: "2026-08", distributable: "1.00", reserve: "0.00", evidenceRef: "synthetic-replacement"
    }, deps)).rejects.toThrow("期初余额已确认且不可覆盖");
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("预存与提款需有唯一来源引用，并禁止重复记收入投影", async () => {
    const { tx, deps } = mockDeps();
    await expect(savePersonalLedgerEntry({
      targetUserId: "synthetic-user-1", period: "2026-08", kind: "SELF_FUNDING_IN", amount: "500.00",
      sourceRef: "synthetic-bank-row-2", note: "合成预存"
    }, deps)).resolves.toEqual({ id: "personal-ledger-1" });
    expect(tx.financePersonLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetUserId: "synthetic-user-1", kind: "SELF_FUNDING_IN", amount: expect.any(Prisma.Decimal) })
    }));

    tx.financePersonLedgerEntry.findFirst.mockResolvedValue({ id: "personal-ledger-1" });
    await expect(savePersonalLedgerEntry({
      targetUserId: "synthetic-user-1", period: "2026-08", kind: "SELF_FUNDING_IN", amount: "500.00",
      sourceRef: "synthetic-bank-row-2", note: "合成重复"
    }, deps)).rejects.toThrow("该来源已记入个人内账");
    await expect(savePersonalLedgerEntry({
      targetUserId: "synthetic-user-1", period: "2026-08", kind: "EARNED_INCOME", amount: "100.00",
      sourceRef: "synthetic-income"
    }, deps)).rejects.toThrow("个人内账事件信息不完整");
  });

  it("视同工资区分申报额和实付额，修改追加带版本的修订快照", async () => {
    const { tx, deps } = mockDeps();
    tx.financePayrollFact.findUnique.mockResolvedValue({
      id: "payroll-1", revision: 2, userId: "synthetic-user-1", period: "2026-08",
      grossSalary: "7000.00", actualCashPaid: "0.00", selfCostDue: "1200.00",
      firmSalaryCost: "0.00", firmSocialCost: "0.00", firmFundCost: "0.00", isDeemedWage: true
    });
    await savePayrollFact({
      userId: "synthetic-user-1", period: "2026-08", grossSalary: "8000.00", commission: "0.00",
      socialPersonal: "600.00", socialCompany: "500.00", fundPersonal: "300.00", fundCompany: "200.00",
      incomeTax: "100.00", otherDeduction: "0.00", reimbursement: "0.00", actualPaymentPeriod: "2026-08",
      isDeemedWage: true, actualCashPaid: "0.00", selfCostDue: "1300.00", firmSalaryCost: "0.00",
      firmSocialCost: "0.00", firmFundCost: "0.00", treatmentReviewed: true, treatmentNote: "合成确认"
    }, deps);

    expect(tx.financePayrollFact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ isDeemedWage: true, actualCashPaid: "0.00", selfCostDue: "1300.00", revision: { increment: 1 } })
    }));
    expect(tx.financePayrollFactRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ payrollFactId: "payroll-1", version: 3, before: expect.any(Object), after: expect.any(Object) })
    }));
    await expect(savePayrollFact({
      userId: "synthetic-user-1", period: "2026-08", grossSalary: "8000.00", commission: "0.00",
      socialPersonal: "0.00", socialCompany: "0.00", fundPersonal: "0.00", fundCompany: "0.00",
      incomeTax: "0.00", otherDeduction: "0.00", reimbursement: "0.00", isDeemedWage: true,
      actualCashPaid: "1.00", selfCostDue: "0.00", firmSalaryCost: "0.00", firmSocialCost: "0.00", firmFundCost: "0.00"
    }, deps)).rejects.toThrow("视同工资不能登记实际支付");
  });

  it("后续人工修订不清除工资事实的导入来源批次", async () => {
    const { tx, deps } = mockDeps();
    tx.financePayrollFact.findUnique.mockResolvedValue({
      id: "payroll-1", revision: 1, userId: "synthetic-user-1", period: "2026-08", sourceBatchId: "synthetic-source-batch",
      grossSalary: "15000.00", commission: "0.00", socialPersonal: "0.00", socialCompany: "0.00",
      fundPersonal: "0.00", fundCompany: "0.00", incomeTax: "0.00", otherDeduction: "0.00", reimbursement: "0.00",
      actualCashPaid: "12000.00", selfCostDue: "800.00", firmSalaryCost: "0.00", firmSocialCost: "0.00", firmFundCost: "0.00"
    });

    await savePayrollFact({
      userId: "synthetic-user-1", period: "2026-08", grossSalary: "15000.00", commission: "0.00",
      socialPersonal: "0.00", socialCompany: "0.00", fundPersonal: "0.00", fundCompany: "0.00",
      incomeTax: "0.00", otherDeduction: "0.00", reimbursement: "0.00", actualCashPaid: "12000.00",
      selfCostDue: "800.00", firmSalaryCost: "1000.00", firmSocialCost: "0.00", firmFundCost: "0.00",
      treatmentReviewed: true, treatmentNote: "合成复核"
    }, deps);

    expect(tx.financePayrollFact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ sourceBatchId: "synthetic-source-batch" })
    }));
    expect(tx.financePayrollFactRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ after: expect.objectContaining({ sourceBatchId: "synthetic-source-batch" }) })
    }));
  });

  it("内账查询按期间返回四类事实，不默认连接真实库", async () => {
    const { db, deps } = mockDeps();
    db.financePayrollFact.findMany.mockResolvedValue([{ id: "payroll-1", amount: "15000.00" }]);
    const result = await getInternalAccounting({ period: "2026-08" }, deps);
    expect(result).toMatchObject({ period: "2026-08", payrollFacts: [{ id: "payroll-1" }], taxRecords: [], capitalFlows: [], ledgerEntries: [], adjustments: [] });
  });
});
