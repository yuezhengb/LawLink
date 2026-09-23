export type FinanceDecimal = string;

export type FinanceSourceKind =
  | "BANK_STATEMENT"
  | "PAYROLL"
  | "ROSTER"
  | "EXTERNAL_THREE_STATEMENTS"
  | "OTHER";

export type FinanceDirection = "CREDIT" | "DEBIT" | "UNKNOWN";

export type FinanceNormalizedRow = {
  sourceKind: FinanceSourceKind;
  sourceBatchId?: string;
  sourceFileId?: string;
  sourceRowNumber: number;
  occurredAt: string;
  amount: FinanceDecimal;
  direction: FinanceDirection;
  balance?: FinanceDecimal | null;
  counterparty?: string | null;
  counterpartyDigest?: string | null;
  accountMasked?: string | null;
  description?: string | null;
  descriptionDigest?: string | null;
  externalReference?: string | null;
  invoiceReference?: string | null;
};

export type FinanceRowError = {
  rowNumber: number;
  code:
    | "MISSING_OCCURRED_AT"
    | "INVALID_OCCURRED_AT"
    | "MISSING_AMOUNT"
    | "INVALID_AMOUNT"
    | "INVALID_DIRECTION"
    | "INVALID_COLUMN_MAPPING"
    | "UNSUPPORTED_LEGACY_XLS"
    | "UNSUPPORTED_FILE_FORMAT"
    | "EMPTY_WORKBOOK"
    | "PARSE_FAILURE"
    | "MISSING_PERIOD"
    | "INVALID_PERIOD"
    | "MISSING_NAME"
    | "MISSING_AS_OF_DAY"
    | "INVALID_STATEMENT";
  field?: string;
  message: string;
};

export type FinanceColumnMapping = Partial<Record<
  | "occurredAt"
  | "counterparty"
  | "debit"
  | "credit"
  | "amount"
  | "balance"
  | "account"
  | "description"
  | "externalReference"
  | "invoiceReference", string>>;

export type FinanceParseResult = {
  fileName: string;
  kind: "BANK_STATEMENT";
  headers: string[];
  rows: FinanceNormalizedRow[];
  errors: FinanceRowError[];
  totalRows: number;
  reviewWarnings?: string[];
  period?: string;
  asOfDay?: string;
};

export type FinanceImportStatus = "PREVIEW" | "COMMITTED" | "FAILED" | "REJECTED";
export type FinanceMatchStatus =
  | "UNRESOLVED"
  | "SUGGESTED"
  | "CONFIRMED"
  | "IGNORED"
  | "SUSPECT"
  | "EXCEPTION";
export type FinanceCalculationStatus = "PREVIEW" | "COMMITTED" | "FAILED" | "SUPERSEDED";
export type FinancePersonLedgerEntryKind =
  | "EARNED_INCOME"
  | "SELF_COST"
  | "SELF_FUNDING_IN"
  | "SELF_FUNDING_USED"
  | "INCOME_WITHDRAWAL"
  | "PARTNER_TAX_ADVANCE"
  | "PERSONAL_TAX_PAID"
  | "CAPITAL_IN"
  | "CAPITAL_OUT"
  | "ADJUSTMENT";
export type FinanceMatterOrigin = "DIRECT" | "CHANNEL" | "SOURCE" | "REFERRAL" | "OTHER";
export type FinanceTaxPhase = "ESTIMATED" | "ADVANCED" | "PERSONALLY_PAID" | "SETTLED";
export type FinanceCapitalFlowKind = "CAPITAL_IN" | "CAPITAL_OUT" | "INCOME_WITHDRAWAL";
export type FinanceAdjustmentStatus = "POSTED" | "REVERSED";

export type ConfirmedPaymentCandidate = {
  paymentId: string;
  matterId: string;
  feeEntryId: string;
  occurredAt: string;
  amount: FinanceDecimal;
  moneyKind: "LAWYER_FEE";
  confirmState: "CONFIRMED";
  externalReference?: string | null;
  invoiceReference?: string | null;
  alreadyUsed?: boolean;
};

export type FinanceMatchSuggestion = {
  paymentId: string;
  score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  autoConfirm: boolean;
  candidateSummary?: string;
};

export type RefundPaymentCandidate = {
  paymentId: string;
  matterCode: string;
  occurredAt: string;
  refundedAmount: FinanceDecimal;
  linkedRefundAmount: FinanceDecimal;
};

export type ReconciliationQuery = {
  batchId?: string;
  status?: FinanceMatchStatus;
  periodStart?: string;
  periodEnd?: string;
  matterId?: string;
  page?: number;
  pageSize?: number;
};

export type ReconciliationDecisionInput = {
  caseId: string;
  decision: "CONFIRM" | "IGNORE" | "SUSPECT";
  paymentId?: string;
  reason?: string;
};

export type RefundLinkInput = {
  sourceRowId: string;
  paymentId: string;
  amount: FinanceDecimal;
  reason: string;
};

export type ReconciliationQueue = {
  items: Array<{
    id: string;
    sourceRowId: string;
    status: FinanceMatchStatus;
    row: FinanceNormalizedRow;
    suggestions: FinanceMatchSuggestion[];
  }>;
  total: number;
};

export type FinanceImportPreview = {
  fileName: string;
  kind: FinanceSourceKind;
  headers: string[];
  rows: Array<FinanceNormalizedRow | FinancePayrollImportRow | FinanceRosterImportRow | FinanceExternalStatementImportRow>;
  errors: FinanceRowError[];
  validCount: number;
  totalRows: number;
  reviewWarnings?: string[];
  period?: string;
  asOfDay?: string;
};

export type CommitFinanceImportInput = {
  fileName: string;
  kind: FinanceSourceKind;
  bytes: Buffer;
  mapping?: FinanceColumnMapping;
  period?: string;
  asOfDay?: string;
};

export type FinanceRuleDefinition = {
  kind: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  percentages?: Record<string, FinanceDecimal>;
  fixedAmounts?: Record<string, FinanceDecimal>;
  roundingMode: "HALF_UP" | "DOWN" | "UP";
  sourceNote: string;
};

export type FinanceCalculationRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  sourceHash: string;
  ruleVersionIds: string[];
  status: FinanceCalculationStatus;
  trigger: "PREVIEW" | "MANUAL" | "MONTHLY_CLOSE";
  calculatedAt: string;
};

export type FinanceArtifact = {
  id: string;
  runId: string;
  kind: "WAGE" | "ACCOUNTANT" | "PERSONAL" | "ADJUSTMENT_AUDIT" | "ZIP";
  fileName: string;
  sha256: string;
  size: number;
};

export type PersonalDoubleBalanceInput = {
  openingDistributable: FinanceDecimal;
  openingReserve: FinanceDecimal;
  earnedIncome: FinanceDecimal;
  selfCostDue: FinanceDecimal;
  reserveTargetMonthlyCost?: FinanceDecimal;
  selfFundingIn: FinanceDecimal;
  withdrawn: FinanceDecimal;
  partnerTaxAdvance: FinanceDecimal;
  unsettledHold: FinanceDecimal;
};

export type PersonalDoubleBalance = {
  selfFundingUsed: FinanceDecimal;
  selfCostChargedToIncome: FinanceDecimal;
  selfFundingReserveEnd: FinanceDecimal;
  reserveGap: FinanceDecimal;
  distributableEnd: FinanceDecimal;
};

export type FirmOperatingResultInput = {
  feeRevenue: FinanceDecimal;
  otherOperatingIncome?: FinanceDecimal;
  incomeWithdrawal: FinanceDecimal;
  partnerTaxAdvance: FinanceDecimal;
  firmSalary: FinanceDecimal;
  firmSocial: FinanceDecimal;
  firmFund?: FinanceDecimal;
  rent: FinanceDecimal;
  office?: FinanceDecimal;
  otherCosts?: FinanceDecimal;
  channel: FinanceDecimal;
  lawyer: FinanceDecimal;
  taxes: FinanceDecimal;
};

export type FinancePayrollImportRow = {
  sourceRowNumber: number;
  period: string;
  displayName: string;
  declaredSalary: FinanceDecimal;
  actualCashPaid: FinanceDecimal;
  selfCostDue: FinanceDecimal;
};

export type FinanceRosterImportRow = {
  sourceRowNumber: number;
  asOfDay: string;
  displayName: string;
  roleLabel: string;
};

export type FinanceExternalStatementImportRow = {
  sourceRowNumber: number;
  period: string;
  statement: "BALANCE_SHEET" | "INCOME" | "CASH_FLOW";
  item: string;
  amount: FinanceDecimal;
};

export type FinanceTypedParseResult<T, K extends FinanceSourceKind> = {
  fileName: string;
  kind: K;
  headers: string[];
  rows: T[];
  errors: FinanceRowError[];
  totalRows: number;
  reviewWarnings?: string[];
  period?: string;
  asOfDay?: string;
};

export type FinanceSourceParseResult =
  | FinanceParseResult
  | FinanceTypedParseResult<FinancePayrollImportRow, "PAYROLL">
  | FinanceTypedParseResult<FinanceRosterImportRow, "ROSTER">
  | FinanceTypedParseResult<FinanceExternalStatementImportRow, "EXTERNAL_THREE_STATEMENTS">
  | FinanceTypedParseResult<never, "OTHER">;

export type FinanceSourceParseOptions = { period?: string; asOfDay?: string };

export type FinancePeriodCoverageInput = {
  bankAccounts: Array<{ alias: string; batchIds: string[]; noTransactionsReason?: string }>;
  payrollBatchIds: string[];
  noPayrollReason?: string;
  rosterBatchIds: string[];
  noRosterReason?: string;
  externalBatchIds: string[];
  noExternalReason?: string;
};

export type FirmOperatingResult = {
  operatingResult: FinanceDecimal;
};
