-- 律所新版分配：保留旧总额行，增量记录角色分配与退款事件。
ALTER TABLE "FinanceMatterProfile"
  ADD COLUMN "roleAssignments" JSONB NOT NULL DEFAULT '[]';

CREATE TYPE "FinanceAllocationRole" AS ENUM ('SOURCE', 'HANDLING', 'CO');
CREATE TYPE "FinanceAllocationSourceKind" AS ENUM ('PAYMENT', 'REFUND');

ALTER TABLE "FinanceAllocationLine"
  ADD COLUMN "sourceKind" "FinanceAllocationSourceKind" NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "refundLinkId" TEXT,
  ADD COLUMN "sourceOccurredAt" TIMESTAMP(3);

CREATE TABLE "FinanceAllocationRecipient" (
  "id" TEXT NOT NULL,
  "allocationLineId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "FinanceAllocationRole" NOT NULL,
  "shareRate" DECIMAL(8,6) NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceAllocationRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceAllocationLine_runId_refundLinkId_key"
  ON "FinanceAllocationLine"("runId", "refundLinkId");
CREATE INDEX "FinanceAllocationLine_sourceKind_sourceOccurredAt_idx"
  ON "FinanceAllocationLine"("sourceKind", "sourceOccurredAt");
CREATE UNIQUE INDEX "FinanceAllocationRecipient_allocationLineId_userId_role_key"
  ON "FinanceAllocationRecipient"("allocationLineId", "userId", "role");
CREATE INDEX "FinanceAllocationRecipient_userId_createdAt_idx"
  ON "FinanceAllocationRecipient"("userId", "createdAt");

ALTER TABLE "FinanceAllocationLine"
  ADD CONSTRAINT "FinanceAllocationLine_refundLinkId_fkey"
  FOREIGN KEY ("refundLinkId") REFERENCES "FinanceRefundLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceAllocationRecipient"
  ADD CONSTRAINT "FinanceAllocationRecipient_allocationLineId_fkey"
  FOREIGN KEY ("allocationLineId") REFERENCES "FinanceAllocationLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceAllocationRecipient_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
