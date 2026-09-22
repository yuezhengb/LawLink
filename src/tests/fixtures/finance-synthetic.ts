import type {
  FinanceNormalizedRow,
  FinancePersonLedgerEntryKind,
  FinanceSourceKind
} from "@/lib/finance/internal-types";

type SyntheticUser = { id: string; name: string; role: "LAWYER" | "FINANCE" };
type SyntheticClient = { id: string; name: string };
type SyntheticMatter = { id: string; internalCode: string; title: string; clientId: string; ownerId: string };

type SyntheticPayment = {
  id: string;
  matterId: string;
  feeEntryId: string;
  amount: string;
  occurredAt: string;
  moneyKind: "LAWYER_FEE";
  confirmState: "CONFIRMED";
};

type SyntheticPendingReceipt = {
  id: string;
  matterId: string;
  amount: string;
  occurredAt: string;
  moneyKind: "LAWYER_FEE";
  confirmState: "PENDING";
};

type SyntheticRefund = {
  id: string;
  paymentId: string;
  matterId: string;
  amount: string;
  occurredAt: string;
  moneyKind: "LAWYER_FEE";
  reason: string;
};

type SyntheticExpense = {
  id: string;
  matterId: string;
  amount: string;
  occurredAt: string;
  kind: "COST";
};

type SyntheticPayroll = {
  id: string;
  userId: string;
  period: string;
  grossSalary: string;
  incomeTax: string;
};

type SyntheticCapitalFlow = {
  id: string;
  investorId: string;
  period: string;
  amount: string;
  kind: "CAPITAL_IN" | "CAPITAL_OUT" | "INCOME_WITHDRAWAL";
};

export type SyntheticFinanceFixture = {
  users: SyntheticUser[];
  client: SyntheticClient;
  matter: SyntheticMatter;
  confirmedPayment: SyntheticPayment;
  pendingReceipt: SyntheticPendingReceipt;
  refund: SyntheticRefund;
  expense: SyntheticExpense;
  payrollFacts: SyntheticPayroll[];
  capitalFlow: SyntheticCapitalFlow;
  bankRow: FinanceNormalizedRow;
  ledgerEntryKind: FinancePersonLedgerEntryKind;
  sourceKind: FinanceSourceKind;
};

export function makeSyntheticFinanceFixture(): SyntheticFinanceFixture {
  const users: SyntheticUser[] = [
    { id: "synthetic-user-1", name: "合成人员一", role: "LAWYER" },
    { id: "synthetic-user-2", name: "合成人员二", role: "FINANCE" }
  ];
  const client: SyntheticClient = { id: "synthetic-client-1", name: "合成客户" };
  const matter: SyntheticMatter = {
    id: "synthetic-matter-1",
    internalCode: "SYN-2026-001",
    title: "合成案件",
    clientId: client.id,
    ownerId: users[0].id
  };
  const confirmedPayment: SyntheticPayment = {
    id: "synthetic-payment-1",
    matterId: matter.id,
    feeEntryId: "synthetic-fee-entry-1",
    amount: "100000.00",
    occurredAt: "2026-08-01",
    moneyKind: "LAWYER_FEE",
    confirmState: "CONFIRMED"
  };
  const pendingReceipt: SyntheticPendingReceipt = {
    id: "synthetic-pending-receipt-1",
    matterId: matter.id,
    amount: "20000.00",
    occurredAt: "2026-08-02",
    moneyKind: "LAWYER_FEE",
    confirmState: "PENDING"
  };
  return {
    users,
    client,
    matter,
    confirmedPayment,
    pendingReceipt,
    refund: {
      id: "synthetic-refund-1",
      paymentId: confirmedPayment.id,
      matterId: matter.id,
      amount: "10000.00",
      occurredAt: "2026-08-05",
      moneyKind: "LAWYER_FEE",
      reason: "合成退款"
    },
    expense: {
      id: "synthetic-expense-1",
      matterId: matter.id,
      amount: "12000.00",
      occurredAt: "2026-08-06",
      kind: "COST"
    },
    payrollFacts: [
      { id: "synthetic-payroll-1", userId: users[0].id, period: "2026-08", grossSalary: "15000.00", incomeTax: "500.00" },
      { id: "synthetic-payroll-2", userId: users[1].id, period: "2026-08", grossSalary: "12000.00", incomeTax: "300.00" }
    ],
    capitalFlow: {
      id: "synthetic-capital-1",
      investorId: users[1].id,
      period: "2026-08",
      amount: "50000.00",
      kind: "CAPITAL_IN"
    },
    bankRow: {
      sourceKind: "BANK_STATEMENT",
      sourceRowNumber: 2,
      occurredAt: "2026-08-01",
      amount: "100000.00",
      direction: "CREDIT",
      counterparty: "合成客户",
      counterpartyDigest: "synthetic-counterparty",
      description: "合成律师费",
      descriptionDigest: "synthetic-description",
      externalReference: "synthetic-ref-1",
      invoiceReference: null,
      accountMasked: "****0001"
    },
    ledgerEntryKind: "EARNED_INCOME",
    sourceKind: "BANK_STATEMENT"
  };
}
