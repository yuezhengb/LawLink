import { createHash, createHmac } from "node:crypto";
import type { FinanceNormalizedRow } from "@/lib/finance/internal-types";
import { getStorageEncryptionKey } from "@/lib/storage/crypto";

function normalizeForHash(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalizeForHash(record[key]);
        return result;
      }, {});
  }
  return value;
}

export function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeTypedFacts(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
  if (Array.isArray(value)) return value.map(normalizeTypedFacts);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = normalizeTypedFacts(record[key]);
      return result;
    }, {});
  }
  return value;
}

export function financeTypedRecordFingerprint(
  kind: "PAYROLL" | "ROSTER" | "EXTERNAL_THREE_STATEMENTS",
  facts: Record<string, unknown>,
  key: Buffer = getStorageEncryptionKey()
): string {
  const payload = `lawlink:finance-import-record:v1\0${kind}\0${JSON.stringify(normalizeTypedFacts(facts))}`;
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

export function rowFingerprint(row: FinanceNormalizedRow): string {
  const safePayload = {
    sourceKind: row.sourceKind,
    sourceSheet: row.sourceSheet ?? "",
    sourceRowNumber: row.sourceRowNumber,
    occurredAt: row.occurredAt,
    amount: row.amount,
    direction: row.direction,
    balance: row.balance ?? null,
    counterpartyDigest: row.counterpartyDigest ?? null,
    accountMasked: row.accountMasked ?? null,
    descriptionDigest: row.descriptionDigest ?? null,
    externalReference: row.externalReference ?? null,
    invoiceReference: row.invoiceReference ?? null
  };
  return createHash("sha256")
    .update(JSON.stringify(normalizeForHash(safePayload)), "utf8")
    .digest("hex");
}
