-- 律所经营财务闭环增量迁移。
-- 只创建 Finance* 新表/枚举；既有业务表不清理、不重建、不改写。

CREATE TYPE "FinanceImportKind" AS ENUM ('BANK_STATEMENT', 'PAYROLL', 'ROSTER', 'EXTERNAL_THREE_STATEMENTS', 'OTHER');
CREATE TYPE "FinanceImportBatchStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'FAILED', 'REJECTED');
CREATE TYPE "FinanceDirection" AS ENUM ('CREDIT', 'DEBIT', 'UNKNOWN');
CREATE TYPE "FinanceReconciliationStatus" AS ENUM ('UNRESOLVED', 'SUGGESTED', 'CONFIRMED', 'IGNORED', 'SUSPECT', 'EXCEPTION');
CREATE TYPE "FinanceDecisionKind" AS ENUM ('CONFIRM', 'IGNORE', 'SUSPECT');
CREATE TYPE "FinanceCalculationRunStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'FAILED', 'SUPERSEDED');
CREATE TYPE "FinanceCalculationTrigger" AS ENUM ('PREVIEW', 'MANUAL', 'MONTHLY_CLOSE');
CREATE TYPE "FinanceMatterOrigin" AS ENUM ('DIRECT', 'CHANNEL', 'SOURCE', 'REFERRAL', 'OTHER');
CREATE TYPE "FinanceLedgerEntryKind" AS ENUM ('EARNED_INCOME', 'SELF_COST', 'SELF_FUNDING_IN', 'SELF_FUNDING_USED', 'INCOME_WITHDRAWAL', 'PARTNER_TAX_ADVANCE', 'PERSONAL_TAX_PAID', 'CAPITAL_IN', 'CAPITAL_OUT', 'ADJUSTMENT');
CREATE TYPE "FinanceTaxPhase" AS ENUM ('ESTIMATED', 'ADVANCED', 'PERSONALLY_PAID', 'SETTLED');
CREATE TYPE "FinanceCapitalFlowKind" AS ENUM ('CAPITAL_IN', 'CAPITAL_OUT', 'INCOME_WITHDRAWAL');
CREATE TYPE "FinanceAdjustmentStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "FinanceCloseStatus" AS ENUM ('OPEN', 'READY', 'CLOSED');
CREATE TYPE "FinanceArtifactKind" AS ENUM ('WAGE', 'ACCOUNTANT', 'PERSONAL', 'ADJUSTMENT_AUDIT', 'ZIP');
CREATE TYPE "FinanceRuleRoundingMode" AS ENUM ('HALF_UP', 'DOWN', 'UP');

CREATE TABLE "FinanceImportBatch" (
    "id" TEXT NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "kind" "FinanceImportKind" NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "status" "FinanceImportBatchStatus" NOT NULL DEFAULT 'PREVIEW',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceSourceFile" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "storagePath" VARCHAR(500) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceSourceFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceSourceRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "direction" "FinanceDirection" NOT NULL,
    "balance" DECIMAL(14,2),
    "counterpartyDigest" VARCHAR(64),
    "counterpartyDisplay" VARCHAR(160),
    "accountMasked" VARCHAR(40),
    "descriptionDigest" VARCHAR(64),
    "descriptionDisplay" VARCHAR(300),
    "externalReference" VARCHAR(120),
    "invoiceReference" VARCHAR(120),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceSourceRow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceReconciliationCase" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "matterId" TEXT,
    "paymentId" TEXT,
    "status" "FinanceReconciliationStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceReconciliationCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceClaimDecision" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "decision" "FinanceDecisionKind" NOT NULL,
    "paymentId" TEXT,
    "reason" TEXT,
    "decidedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceClaimDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceRefundLink" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceRefundLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceMatterProfile" (
    "id" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "origin" "FinanceMatterOrigin" NOT NULL,
    "lawyerLevel" VARCHAR(60),
    "channelLabel" VARCHAR(120),
    "participantIds" JSONB NOT NULL DEFAULT '[]',
    "internalNote" VARCHAR(1000),
    "activeRuleSetId" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceMatterProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceRuleSet" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceRuleSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceRuleVersion" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "roundingMode" "FinanceRuleRoundingMode" NOT NULL DEFAULT 'HALF_UP',
    "sourceNote" VARCHAR(1000) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceRuleVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceCalculationRun" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "ruleVersionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "FinanceCalculationRunStatus" NOT NULL DEFAULT 'PREVIEW',
    "trigger" "FinanceCalculationTrigger" NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededById" TEXT,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "FinanceCalculationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceAllocationLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "ruleVersionId" TEXT NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "channelAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "firmAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sourceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "handlingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "coAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceAllocationLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePersonLedgerEntry" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "targetUserId" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "kind" "FinanceLedgerEntryKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sourceRef" VARCHAR(120),
    "note" VARCHAR(1000),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancePersonLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePayrollFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "grossSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "socialPersonal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "socialCompany" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fundPersonal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fundCompany" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "incomeTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reimbursement" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "actualPaymentPeriod" VARCHAR(7),
    "sourceBatchId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinancePayrollFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePartnerTaxRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "estimatedTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "firmAdvance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "personallyPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "personallyPaidAt" TIMESTAMP(3),
    "phase" "FinanceTaxPhase" NOT NULL,
    "evidenceRef" VARCHAR(200),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinancePartnerTaxRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceCapitalFlow" (
    "id" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "kind" "FinanceCapitalFlowKind" NOT NULL,
    "throughPartnerId" TEXT,
    "linkedBankSourceRowId" TEXT,
    "remarks" VARCHAR(1000),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceCapitalFlow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceAdjustment" (
    "id" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "account" VARCHAR(120) NOT NULL,
    "targetUserId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "evidenceRef" VARCHAR(200),
    "reversalOfId" TEXT,
    "status" "FinanceAdjustmentStatus" NOT NULL DEFAULT 'POSTED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceMonthlyClose" (
    "id" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "runId" TEXT,
    "sourceHash" VARCHAR(64),
    "status" "FinanceCloseStatus" NOT NULL DEFAULT 'OPEN',
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
    "unresolvedIncomeCount" INTEGER NOT NULL DEFAULT 0,
    "splitErrorCount" INTEGER NOT NULL DEFAULT 0,
    "missingPayrollCount" INTEGER NOT NULL DEFAULT 0,
    "templateWarnings" JSONB NOT NULL DEFAULT '[]',
    "blockingWarnings" JSONB NOT NULL DEFAULT '[]',
    "reviewWarnings" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinanceMonthlyClose_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceArtifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "monthlyCloseId" TEXT,
    "kind" "FinanceArtifactKind" NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "storagePath" VARCHAR(500) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinanceArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceImportBatch_sourceHash_kind_key" ON "FinanceImportBatch"("sourceHash", "kind");
CREATE INDEX "FinanceImportBatch_periodStart_status_idx" ON "FinanceImportBatch"("periodStart", "status");
CREATE INDEX "FinanceImportBatch_kind_status_idx" ON "FinanceImportBatch"("kind", "status");
CREATE UNIQUE INDEX "FinanceSourceFile_batchId_key" ON "FinanceSourceFile"("batchId");
CREATE INDEX "FinanceSourceFile_sha256_idx" ON "FinanceSourceFile"("sha256");
CREATE UNIQUE INDEX "FinanceSourceRow_batchId_sourceRow_key" ON "FinanceSourceRow"("batchId", "sourceRow");
CREATE INDEX "FinanceSourceRow_sourceFileId_sourceRow_idx" ON "FinanceSourceRow"("sourceFileId", "sourceRow");
CREATE INDEX "FinanceSourceRow_occurredAt_idx" ON "FinanceSourceRow"("occurredAt");
CREATE UNIQUE INDEX "FinanceReconciliationCase_sourceRowId_key" ON "FinanceReconciliationCase"("sourceRowId");
CREATE INDEX "FinanceReconciliationCase_batchId_status_idx" ON "FinanceReconciliationCase"("batchId", "status");
CREATE INDEX "FinanceReconciliationCase_matterId_idx" ON "FinanceReconciliationCase"("matterId");
CREATE INDEX "FinanceReconciliationCase_paymentId_idx" ON "FinanceReconciliationCase"("paymentId");
CREATE INDEX "FinanceClaimDecision_caseId_createdAt_idx" ON "FinanceClaimDecision"("caseId", "createdAt");
CREATE INDEX "FinanceClaimDecision_decidedById_createdAt_idx" ON "FinanceClaimDecision"("decidedById", "createdAt");
CREATE UNIQUE INDEX "FinanceRefundLink_sourceRowId_paymentId_key" ON "FinanceRefundLink"("sourceRowId", "paymentId");
CREATE INDEX "FinanceRefundLink_paymentId_active_idx" ON "FinanceRefundLink"("paymentId", "active");
CREATE UNIQUE INDEX "FinanceMatterProfile_matterId_key" ON "FinanceMatterProfile"("matterId");
CREATE INDEX "FinanceMatterProfile_origin_idx" ON "FinanceMatterProfile"("origin");
CREATE INDEX "FinanceRuleSet_kind_createdAt_idx" ON "FinanceRuleSet"("kind", "createdAt");
CREATE UNIQUE INDEX "FinanceRuleVersion_ruleSetId_version_key" ON "FinanceRuleVersion"("ruleSetId", "version");
CREATE INDEX "FinanceRuleVersion_effectiveFrom_effectiveTo_idx" ON "FinanceRuleVersion"("effectiveFrom", "effectiveTo");
CREATE UNIQUE INDEX "FinanceCalculationRun_periodStart_periodEnd_sourceHash_key" ON "FinanceCalculationRun"("periodStart", "periodEnd", "sourceHash");
CREATE INDEX "FinanceCalculationRun_periodStart_periodEnd_status_idx" ON "FinanceCalculationRun"("periodStart", "periodEnd", "status");
CREATE INDEX "FinanceCalculationRun_sourceHash_idx" ON "FinanceCalculationRun"("sourceHash");
CREATE INDEX "FinanceAllocationLine_runId_idx" ON "FinanceAllocationLine"("runId");
CREATE INDEX "FinanceAllocationLine_paymentId_idx" ON "FinanceAllocationLine"("paymentId");
CREATE INDEX "FinanceAllocationLine_matterId_idx" ON "FinanceAllocationLine"("matterId");
CREATE INDEX "FinanceAllocationLine_targetUserId_idx" ON "FinanceAllocationLine"("targetUserId");
CREATE INDEX "FinancePersonLedgerEntry_targetUserId_period_idx" ON "FinancePersonLedgerEntry"("targetUserId", "period");
CREATE INDEX "FinancePersonLedgerEntry_runId_idx" ON "FinancePersonLedgerEntry"("runId");
CREATE UNIQUE INDEX "FinancePayrollFact_userId_period_key" ON "FinancePayrollFact"("userId", "period");
CREATE INDEX "FinancePayrollFact_period_idx" ON "FinancePayrollFact"("period");
CREATE INDEX "FinancePartnerTaxRecord_userId_period_idx" ON "FinancePartnerTaxRecord"("userId", "period");
CREATE INDEX "FinanceCapitalFlow_period_kind_idx" ON "FinanceCapitalFlow"("period", "kind");
CREATE INDEX "FinanceCapitalFlow_investorId_period_idx" ON "FinanceCapitalFlow"("investorId", "period");
CREATE INDEX "FinanceAdjustment_period_status_idx" ON "FinanceAdjustment"("period", "status");
CREATE INDEX "FinanceAdjustment_targetUserId_period_idx" ON "FinanceAdjustment"("targetUserId", "period");
CREATE UNIQUE INDEX "FinanceMonthlyClose_period_key" ON "FinanceMonthlyClose"("period");
CREATE UNIQUE INDEX "FinanceMonthlyClose_runId_key" ON "FinanceMonthlyClose"("runId");
CREATE INDEX "FinanceMonthlyClose_status_updatedAt_idx" ON "FinanceMonthlyClose"("status", "updatedAt");
CREATE UNIQUE INDEX "FinanceArtifact_runId_kind_key" ON "FinanceArtifact"("runId", "kind");
CREATE INDEX "FinanceArtifact_monthlyCloseId_idx" ON "FinanceArtifact"("monthlyCloseId");

ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceSourceFile" ADD CONSTRAINT "FinanceSourceFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FinanceImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceSourceRow" ADD CONSTRAINT "FinanceSourceRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FinanceImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceSourceRow" ADD CONSTRAINT "FinanceSourceRow_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "FinanceSourceFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceReconciliationCase" ADD CONSTRAINT "FinanceReconciliationCase_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FinanceImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceReconciliationCase" ADD CONSTRAINT "FinanceReconciliationCase_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "FinanceSourceRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceReconciliationCase" ADD CONSTRAINT "FinanceReconciliationCase_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceReconciliationCase" ADD CONSTRAINT "FinanceReconciliationCase_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceClaimDecision" ADD CONSTRAINT "FinanceClaimDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FinanceReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceClaimDecision" ADD CONSTRAINT "FinanceClaimDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRefundLink" ADD CONSTRAINT "FinanceRefundLink_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FinanceReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRefundLink" ADD CONSTRAINT "FinanceRefundLink_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "FinanceSourceRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRefundLink" ADD CONSTRAINT "FinanceRefundLink_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceMatterProfile" ADD CONSTRAINT "FinanceMatterProfile_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceMatterProfile" ADD CONSTRAINT "FinanceMatterProfile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRuleSet" ADD CONSTRAINT "FinanceRuleSet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRuleVersion" ADD CONSTRAINT "FinanceRuleVersion_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "FinanceRuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceRuleVersion" ADD CONSTRAINT "FinanceRuleVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceCalculationRun" ADD CONSTRAINT "FinanceCalculationRun_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "FinanceCalculationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FinanceCalculationRun" ADD CONSTRAINT "FinanceCalculationRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAllocationLine" ADD CONSTRAINT "FinanceAllocationLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAllocationLine" ADD CONSTRAINT "FinanceAllocationLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAllocationLine" ADD CONSTRAINT "FinanceAllocationLine_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAllocationLine" ADD CONSTRAINT "FinanceAllocationLine_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePersonLedgerEntry" ADD CONSTRAINT "FinancePersonLedgerEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePersonLedgerEntry" ADD CONSTRAINT "FinancePersonLedgerEntry_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePayrollFact" ADD CONSTRAINT "FinancePayrollFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePartnerTaxRecord" ADD CONSTRAINT "FinancePartnerTaxRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceCapitalFlow" ADD CONSTRAINT "FinanceCapitalFlow_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAdjustment" ADD CONSTRAINT "FinanceAdjustment_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAdjustment" ADD CONSTRAINT "FinanceAdjustment_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "FinanceAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAdjustment" ADD CONSTRAINT "FinanceAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceMonthlyClose" ADD CONSTRAINT "FinanceMonthlyClose_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceMonthlyClose" ADD CONSTRAINT "FinanceMonthlyClose_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceArtifact" ADD CONSTRAINT "FinanceArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceArtifact" ADD CONSTRAINT "FinanceArtifact_monthlyCloseId_fkey" FOREIGN KEY ("monthlyCloseId") REFERENCES "FinanceMonthlyClose"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
