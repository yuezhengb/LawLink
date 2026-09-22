import { describe, expect, it } from "vitest";
import { fileSha256, rowFingerprint } from "@/lib/finance/source-fingerprint";
import type { FinanceNormalizedRow } from "@/lib/finance/internal-types";

const baseRow: FinanceNormalizedRow = {
  sourceKind: "BANK_STATEMENT",
  sourceRowNumber: 2,
  occurredAt: "2026-08-01",
  amount: "100000.00",
  direction: "CREDIT",
  counterparty: "合成客户",
  counterpartyDigest: "digest-counterparty",
  description: "律师费",
  descriptionDigest: "digest-description"
};

describe("财务来源指纹", () => {
  it("使用 SHA-256 生成文件指纹", () => {
    expect(fileSha256(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("对键顺序和展示文本多余空白不敏感", () => {
    const reordered = {
      descriptionDigest: "digest-description",
      amount: "100000.00",
      sourceRowNumber: 2,
      occurredAt: "2026-08-01",
      direction: "CREDIT",
      sourceKind: "BANK_STATEMENT",
      counterpartyDigest: "digest-counterparty",
      counterparty: "  合成客户  ",
      description: "律师费"
    } as FinanceNormalizedRow;

    expect(rowFingerprint(baseRow)).toBe(rowFingerprint(reordered));
  });

  it("来源行或金额变化会产生不同指纹，且不直接包含原始名称", () => {
    const changed = { ...baseRow, amount: "100001.00" };
    const fingerprint = rowFingerprint(baseRow);

    expect(rowFingerprint(changed)).not.toBe(fingerprint);
    expect(fingerprint).not.toContain("合成客户");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
