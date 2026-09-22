import { shDayKey } from "@/lib/ui/sh-time";
import type {
  ConfirmedPaymentCandidate,
  FinanceMatchSuggestion,
  FinanceNormalizedRow
} from "@/lib/finance/internal-types";

function canonicalAmount(value: string): string | null {
  const text = String(value).replace(/[，,\s]/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [integerPart, decimalPart = ""] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const decimals = decimalPart.padEnd(2, "0");
  const zero = integer === "0" && decimals === "00";
  return `${negative && !zero ? "-" : ""}${integer}.${decimals}`;
}

function dayKey(value: string): string | null {
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  try {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : shDayKey(date);
  } catch {
    return null;
  }
}

function dayDistance(left: string, right: string): number | null {
  const leftKey = dayKey(left);
  const rightKey = dayKey(right);
  if (!leftKey || !rightKey) return null;
  const toUtcDay = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.abs(toUtcDay(leftKey) - toUtcDay(rightKey)) / 86_400_000;
}

function sameReference(row: FinanceNormalizedRow, candidate: ConfirmedPaymentCandidate): boolean {
  const external = row.externalReference && candidate.externalReference;
  const invoice = row.invoiceReference && candidate.invoiceReference;
  return Boolean((external && external === candidate.externalReference) || (invoice && invoice === candidate.invoiceReference));
}

export function rankPaymentCandidates(
  row: FinanceNormalizedRow,
  candidates: ConfirmedPaymentCandidate[]
): FinanceMatchSuggestion[] {
  if (row.direction !== "CREDIT") return [];
  const rowAmount = canonicalAmount(row.amount);
  if (!rowAmount) return [];

  const scored = candidates
    .filter((candidate) => {
      const candidateRecord = candidate as ConfirmedPaymentCandidate & { moneyKind?: string; confirmState?: string };
      return candidateRecord.moneyKind === "LAWYER_FEE" && candidateRecord.confirmState === "CONFIRMED" && candidate.alreadyUsed !== true;
    })
    .flatMap((candidate) => {
      if (canonicalAmount(candidate.amount) !== rowAmount) return [];
      const distance = dayDistance(row.occurredAt, candidate.occurredAt);
      const referenceMatch = sameReference(row, candidate);
      if (!referenceMatch && (distance === null || distance > 3)) return [];
      const score = referenceMatch ? 100 : distance === 0 ? 90 : 70;
      const reason = referenceMatch
        ? "金额与外部流水号或发票号一致"
        : distance === 0
          ? "金额与上海日历日一致"
          : `金额一致，日期相差 ${distance} 天`;
      return [{ candidate, score, reason }];
    });

  scored.sort((left, right) => right.score - left.score || left.candidate.paymentId.localeCompare(right.candidate.paymentId));
  const highScoreCount = scored.filter((item) => item.score >= 90).length;
  return scored.map(({ candidate, score, reason }) => ({
    paymentId: candidate.paymentId,
    score,
    confidence: score >= 90 ? "HIGH" : "MEDIUM",
    reason,
    autoConfirm: score >= 90 && highScoreCount === 1
  }));
}
