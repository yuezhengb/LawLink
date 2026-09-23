-- 律所个人/经营账扩展：添加工资口径、修订快照、经确认期初和账期快照。
-- 本迁移仅新增结构与默认值；旧工资承担口径保持“待核对”，不推定为已确认。
ALTER TABLE "FinancePayrollFact"
  ADD COLUMN "isDeemedWage" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "actualCashPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "selfCostDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "firmSalaryCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "firmSocialCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "firmFundCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "treatmentReviewed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "treatmentNote" VARCHAR(1000),
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

CREATE TYPE "FinanceOperatingCostCategory" AS ENUM ('RENT', 'OFFICE', 'TURNOVER_TAX', 'OTHER');

CREATE TABLE "FinancePayrollFactRevision" (
  "id" TEXT NOT NULL,
  "payrollFactId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "before" JSONB,
  "after" JSONB NOT NULL,
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePayrollFactRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceOpeningBalance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "firstPeriod" VARCHAR(7) NOT NULL,
  "distributable" DECIMAL(14,2) NOT NULL,
  "reserve" DECIMAL(14,2) NOT NULL,
  "evidenceRef" VARCHAR(200) NOT NULL,
  "confirmedById" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceOpeningBalance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePersonPeriodSnapshot" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "openingDistributable" DECIMAL(14,2) NOT NULL,
  "openingReserve" DECIMAL(14,2) NOT NULL,
  "earned" DECIMAL(14,2) NOT NULL,
  "selfCostDue" DECIMAL(14,2) NOT NULL,
  "selfFundingIn" DECIMAL(14,2) NOT NULL,
  "selfFundingUsed" DECIMAL(14,2) NOT NULL,
  "selfCostChargedToIncome" DECIMAL(14,2) NOT NULL,
  "withdrawn" DECIMAL(14,2) NOT NULL,
  "partnerTaxAdvance" DECIMAL(14,2) NOT NULL,
  "unsettledHold" DECIMAL(14,2) NOT NULL,
  "distributableEnd" DECIMAL(14,2) NOT NULL,
  "reserveEnd" DECIMAL(14,2) NOT NULL,
  "reserveGap" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePersonPeriodSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceFirmPeriodSnapshot" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "feeRevenue" DECIMAL(14,2) NOT NULL,
  "channelAmount" DECIMAL(14,2) NOT NULL,
  "lawyerAmount" DECIMAL(14,2) NOT NULL,
  "firmSalaryCost" DECIMAL(14,2) NOT NULL,
  "firmSocialCost" DECIMAL(14,2) NOT NULL,
  "firmFundCost" DECIMAL(14,2) NOT NULL,
  "rentCost" DECIMAL(14,2) NOT NULL,
  "officeCost" DECIMAL(14,2) NOT NULL,
  "turnoverTaxCost" DECIMAL(14,2) NOT NULL,
  "otherCost" DECIMAL(14,2) NOT NULL,
  "operatingResult" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceFirmPeriodSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceOperatingCost" (
  "id" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "category" "FinanceOperatingCostCategory" NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "sourceRowId" TEXT,
  "evidenceRef" VARCHAR(200),
  "description" VARCHAR(1000) NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceOperatingCost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinancePayrollFactRevision_payrollFactId_version_key" ON "FinancePayrollFactRevision"("payrollFactId", "version");
CREATE INDEX "FinancePayrollFactRevision_changedById_changedAt_idx" ON "FinancePayrollFactRevision"("changedById", "changedAt");
CREATE UNIQUE INDEX "FinanceOpeningBalance_userId_key" ON "FinanceOpeningBalance"("userId");
CREATE INDEX "FinanceOpeningBalance_firstPeriod_idx" ON "FinanceOpeningBalance"("firstPeriod");
CREATE UNIQUE INDEX "FinancePersonPeriodSnapshot_runId_userId_key" ON "FinancePersonPeriodSnapshot"("runId", "userId");
CREATE INDEX "FinancePersonPeriodSnapshot_userId_period_idx" ON "FinancePersonPeriodSnapshot"("userId", "period");
CREATE UNIQUE INDEX "FinanceFirmPeriodSnapshot_runId_key" ON "FinanceFirmPeriodSnapshot"("runId");
CREATE INDEX "FinanceFirmPeriodSnapshot_period_idx" ON "FinanceFirmPeriodSnapshot"("period");
CREATE INDEX "FinanceOperatingCost_period_category_idx" ON "FinanceOperatingCost"("period", "category");
CREATE INDEX "FinanceOperatingCost_sourceRowId_idx" ON "FinanceOperatingCost"("sourceRowId");

ALTER TABLE "FinancePayrollFactRevision"
  ADD CONSTRAINT "FinancePayrollFactRevision_payrollFactId_fkey" FOREIGN KEY ("payrollFactId") REFERENCES "FinancePayrollFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinancePayrollFactRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceOpeningBalance"
  ADD CONSTRAINT "FinanceOpeningBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceOpeningBalance_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePersonPeriodSnapshot"
  ADD CONSTRAINT "FinancePersonPeriodSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinancePersonPeriodSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceFirmPeriodSnapshot"
  ADD CONSTRAINT "FinanceFirmPeriodSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinanceCalculationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceOperatingCost"
  ADD CONSTRAINT "FinanceOperatingCost_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "FinanceSourceRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceOperatingCost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
