import { Prisma } from "@prisma/client";
import type {
  FirmOperatingResult,
  FirmOperatingResultInput,
  PersonalDoubleBalance,
  PersonalDoubleBalanceInput
} from "@/lib/finance/internal-types";

function decimal(value: string): Prisma.Decimal {
  const result = new Prisma.Decimal(value);
  if (!result.isFinite()) throw new Error("内账金额不合法");
  return result;
}

function fixed(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(2).toFixed(2);
}

function nonNegative(value: Prisma.Decimal): Prisma.Decimal {
  return value.lt(0) ? new Prisma.Decimal(0) : value;
}

export function buildPersonalDoubleBalance(input: PersonalDoubleBalanceInput): PersonalDoubleBalance {
  const openingDistributable = decimal(input.openingDistributable);
  const openingReserve = decimal(input.openingReserve);
  const earnedIncome = decimal(input.earnedIncome);
  const selfCostDue = decimal(input.selfCostDue);
  const reserveTargetMonthlyCost = decimal(input.reserveTargetMonthlyCost ?? input.selfCostDue);
  const selfFundingIn = decimal(input.selfFundingIn);
  const withdrawn = decimal(input.withdrawn);
  const partnerTaxAdvance = decimal(input.partnerTaxAdvance);
  const unsettledHold = decimal(input.unsettledHold);
  if ([openingReserve, selfCostDue, reserveTargetMonthlyCost, selfFundingIn, withdrawn, partnerTaxAdvance, unsettledHold].some((value) => value.lt(0))) {
    throw new Error("内账成本、提款或预付款不能为负");
  }

  const availableReserve = nonNegative(openingReserve.plus(selfFundingIn));
  const selfFundingUsed = availableReserve.lessThan(selfCostDue) ? availableReserve : selfCostDue;
  const selfFundingReserveEnd = availableReserve.minus(selfFundingUsed);
  const selfCostChargedToIncome = selfCostDue.minus(selfFundingUsed);
  // 两个月保障目标以期末预存为基准；缺口可以跨月结转，不把缺口截断成零。
  const reserveGap = nonNegative(reserveTargetMonthlyCost.mul(2).minus(selfFundingReserveEnd));
  const distributableEnd = openingDistributable
    .plus(earnedIncome)
    .minus(selfCostChargedToIncome)
    .minus(withdrawn)
    .minus(partnerTaxAdvance)
    .minus(unsettledHold);
  return {
    selfFundingUsed: fixed(selfFundingUsed),
    selfCostChargedToIncome: fixed(selfCostChargedToIncome),
    selfFundingReserveEnd: fixed(selfFundingReserveEnd),
    reserveGap: fixed(reserveGap),
    distributableEnd: fixed(distributableEnd)
  };
}

export function buildFirmOperatingResult(input: FirmOperatingResultInput): FirmOperatingResult {
  const feeRevenue = decimal(input.feeRevenue);
  const otherOperatingIncome = decimal(input.otherOperatingIncome ?? "0.00");
  const incomeWithdrawal = decimal(input.incomeWithdrawal);
  const partnerTaxAdvance = decimal(input.partnerTaxAdvance);
  void incomeWithdrawal;
  void partnerTaxAdvance;
  const result = feeRevenue
    .plus(otherOperatingIncome)
    .minus(decimal(input.channel))
    .minus(decimal(input.lawyer))
    .minus(decimal(input.taxes))
    .minus(decimal(input.firmSalary))
    .minus(decimal(input.firmSocial))
    .minus(decimal(input.firmFund ?? "0.00"))
    .minus(decimal(input.rent))
    .minus(decimal(input.office ?? "0.00"))
    .minus(decimal(input.otherCosts ?? "0.00"));
  return { operatingResult: fixed(result) };
}
