-- 类型化资料归档；原始文件仍保存在受控私有存储中，姓名不进入数据库。
CREATE TYPE "FinanceImportReviewStatus" AS ENUM ('NEEDS_REVIEW', 'RESOLVED', 'REJECTED');
CREATE TYPE "FinanceExternalStatementKind" AS ENUM ('BALANCE_SHEET', 'INCOME', 'CASH_FLOW');

CREATE TABLE "FinanceImportRecord" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "sourceRow" INTEGER NOT NULL,
  "kind" "FinanceImportKind" NOT NULL,
  "period" VARCHAR(7),
  "asOfDay" TIMESTAMP(3),
  "roleLabel" VARCHAR(100),
  "statement" "FinanceExternalStatementKind",
  "item" VARCHAR(200),
  "amount" DECIMAL(14,2),
  "declaredSalary" DECIMAL(14,2),
  "actualCashPaid" DECIMAL(14,2),
  "selfCostDue" DECIMAL(14,2),
  "normalizedDigest" VARCHAR(64) NOT NULL,
  "resolvedUserId" TEXT,
  "reviewStatus" "FinanceImportReviewStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceImportRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceImportRecord_batchId_sourceRow_key" ON "FinanceImportRecord"("batchId", "sourceRow");
CREATE INDEX "FinanceImportRecord_period_kind_reviewStatus_idx" ON "FinanceImportRecord"("period", "kind", "reviewStatus");
CREATE INDEX "FinanceImportRecord_resolvedUserId_idx" ON "FinanceImportRecord"("resolvedUserId");

ALTER TABLE "FinanceImportRecord"
  ADD CONSTRAINT "FinanceImportRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FinanceImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceImportRecord_resolvedUserId_fkey" FOREIGN KEY ("resolvedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 保留每一次正式月结历史，不再按期间覆盖旧月结行。
DROP INDEX "FinanceMonthlyClose_period_key";
ALTER TABLE "FinanceMonthlyClose" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "FinanceMonthlyClose_period_revision_key" ON "FinanceMonthlyClose"("period", "revision");

CREATE TABLE "FinancePeriodCoverage" (
  "id" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "details" JSONB NOT NULL,
  "confirmedById" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancePeriodCoverage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinancePeriodCoverage_period_key" ON "FinancePeriodCoverage"("period");
ALTER TABLE "FinancePeriodCoverage"
  ADD CONSTRAINT "FinancePeriodCoverage_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
