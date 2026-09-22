import { Prisma } from "@prisma/client";
import { z } from "zod";

const dateKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/, "日期必须是 YYYY-MM-DD");
const decimalTextSchema = z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, "金额必须是非负数字且最多两位小数");

export const financeRuleDefinitionSchema = z
  .object({
    kind: z.string().trim().min(1).max(60),
    effectiveFrom: dateKeySchema,
    effectiveTo: dateKeySchema.nullish(),
    percentages: z.record(z.string(), decimalTextSchema).default({}),
    fixedAmounts: z.record(z.string(), decimalTextSchema).default({}),
    roundingMode: z.enum(["HALF_UP", "DOWN", "UP"]),
    sourceNote: z.string().trim().min(1).max(1000)
  })
  .superRefine((value, context) => {
    if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "规则结束日期必须晚于开始日期" });
    }
  });

export const financeMatterProfileSchema = z.object({
  matterId: z.string().trim().min(1).max(100),
  origin: z.enum(["DIRECT", "CHANNEL", "SOURCE", "REFERRAL", "OTHER"]),
  lawyerLevel: z.string().trim().max(60).nullish(),
  channelLabel: z.string().trim().max(120).nullish(),
  participantIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  internalNote: z.string().trim().max(1000).nullish(),
  activeRuleSetId: z.string().trim().max(100).nullish()
});

export type AllocationInput = {
  gross: string;
  channelRate: string;
  firmRate: string;
  sourceRate: string;
  handlingRate: string;
  coRate: string;
};

export type AllocationResult = {
  channel: Prisma.Decimal;
  firm: Prisma.Decimal;
  source: Prisma.Decimal;
  handling: Prisma.Decimal;
  co: Prisma.Decimal;
};

function decimal(value: string): Prisma.Decimal {
  try {
    const result = new Prisma.Decimal(value);
    if (!result.isFinite()) throw new Error("not finite");
    return result;
  } catch {
    throw new Error("分配金额不合法");
  }
}

function assertRate(value: Prisma.Decimal): void {
  if (!value.isFinite() || value.lt(0) || value.gt(1)) throw new Error("分配比例不合法");
}

/**
 * 分配口径：先从总额扣渠道费；渠道后的余额按律所留存比例取留存，
 * 再将剩余池按案源/承办/协办比例拆分。最后一项使用守恒残差吸收分币尾差。
 */
export function calculateAllocation(input: AllocationInput): AllocationResult {
  const gross = decimal(input.gross);
  const channelRate = decimal(input.channelRate);
  const firmRate = decimal(input.firmRate);
  const sourceRate = decimal(input.sourceRate);
  const handlingRate = decimal(input.handlingRate);
  const coRate = decimal(input.coRate);
  if (gross.lt(0)) throw new Error("分配金额不合法");
  [channelRate, firmRate, sourceRate, handlingRate, coRate].forEach(assertRate);
  if (!sourceRate.plus(handlingRate).plus(coRate).eq(1)) throw new Error("分配比例不合法");

  const channel = gross.mul(channelRate).toDecimalPlaces(2);
  const afterChannel = gross.minus(channel);
  const firm = afterChannel.mul(firmRate).toDecimalPlaces(2);
  const rolePool = afterChannel.minus(firm);
  const source = rolePool.mul(sourceRate).toDecimalPlaces(2);
  const handling = rolePool.mul(handlingRate).toDecimalPlaces(2);
  const co = gross.minus(channel).minus(firm).minus(source).minus(handling).toDecimalPlaces(2);
  if (co.lt(0)) throw new Error("分配比例不合法");
  return { channel, firm, source, handling, co };
}
