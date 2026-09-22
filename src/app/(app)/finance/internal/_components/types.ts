import type {
  FinanceMatchStatus,
  FinanceNormalizedRow,
  FinanceMatchSuggestion,
  ReconciliationQueue
} from "@/lib/finance/internal-types";

export type InternalImportBatch = {
  id: string;
  kind: string;
  fileName: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  errorCount: number;
  createdAt: string;
};

export type LedgerPerson = {
  calculationRunId: string;
  userId: string | null;
  userName: string;
  grossIncome: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
};

export type LedgerProjectLine = {
  sourcePaymentId: string;
  grossAmount: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
};

export type LedgerProject = {
  calculationRunId: string;
  matterId: string;
  matterCode: string;
  matterTitle: string;
  clientReference: string | null;
  lines: LedgerProjectLine[];
};

export type LedgerFirm = {
  calculationRunId: string;
  feeRevenue: string;
  channelAmount: string;
  firmAmount: string;
  lawyerAmount: string;
  operatingResult: string;
};

export type PersonalBalance = {
  userId: string;
  userName: string;
  distributableEnd: string;
  selfFundingReserveEnd: string;
  reserveGap: string;
};

export type InternalLedgerView = {
  calculationRunId?: string | null;
  periodStart?: string;
  periodEnd?: string;
  persons: LedgerPerson[];
  projects: LedgerProject[];
  firm: LedgerFirm | null;
  personalBalances?: PersonalBalance[];
};

export type ReconciliationItem = ReconciliationQueue["items"][number];
export type ReconciliationWorkspaceQueue = {
  items: Array<{
    id: string;
    status: FinanceMatchStatus;
    row: FinanceNormalizedRow;
    suggestions: FinanceMatchSuggestion[];
  }>;
  total: number;
};

export type InternalRuleVersion = {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceNote: string;
  publishedAt: string | null;
  definition: { kind?: string; percentages?: Record<string, string>; roundingMode?: string };
};

export type InternalRuleSet = {
  id: string;
  name: string;
  kind: string;
  versions: InternalRuleVersion[];
};

export type MonthlyCloseArtifact = {
  id: string;
  kind: string;
  fileName: string;
  byteSize: number;
  sha256: string;
};

export type MonthlyCloseAdjustment = {
  id: string;
  account: string;
  targetUserId: string | null;
  amount: string;
  reason: string;
  status: string;
  reversalOfId: string | null;
  createdAt: string;
};

export type MonthlyCloseWorkspaceData = {
  period: string;
  status: {
    ready: boolean;
    sourceFiles: number;
    sourceKinds: string[];
    transactionCount: number;
    unresolvedCount: number;
    unresolvedIncomeCount: number;
    splitErrorCount: number;
    missingPayrollCount: number;
    templateWarnings: string[];
    blockingWarnings: string[];
    reviewWarnings: string[];
    runId: string | null;
    sourceHash: string | null;
  };
  artifacts: MonthlyCloseArtifact[];
  adjustments: MonthlyCloseAdjustment[];
};
