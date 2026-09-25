ALTER TABLE "FinanceSourceRow"
  ADD COLUMN "sourceSheet" TEXT NOT NULL DEFAULT '';

ALTER TABLE "FinanceImportRecord"
  ADD COLUMN "sourceSheet" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "displayName" VARCHAR(120);

DROP INDEX "FinanceSourceRow_batchId_sourceRow_key";
CREATE UNIQUE INDEX "FinanceSourceRow_batchId_sourceSheet_sourceRow_key"
  ON "FinanceSourceRow"("batchId", "sourceSheet", "sourceRow");

DROP INDEX "FinanceImportRecord_batchId_sourceRow_key";
CREATE UNIQUE INDEX "FinanceImportRecord_batchId_sourceSheet_sourceRow_key"
  ON "FinanceImportRecord"("batchId", "sourceSheet", "sourceRow");

CREATE TABLE "FinanceImportMappingTemplate" (
  "id" TEXT NOT NULL,
  "kind" "FinanceImportKind" NOT NULL,
  "headersDigest" VARCHAR(64) NOT NULL,
  "mapping" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinanceImportMappingTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceImportMappingTemplate_kind_headersDigest_key"
  ON "FinanceImportMappingTemplate"("kind", "headersDigest");
CREATE INDEX "FinanceImportMappingTemplate_createdById_createdAt_idx"
  ON "FinanceImportMappingTemplate"("createdById", "createdAt");

ALTER TABLE "FinanceImportMappingTemplate"
  ADD CONSTRAINT "FinanceImportMappingTemplate_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
