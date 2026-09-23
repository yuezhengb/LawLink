import { Prisma } from "@prisma/client";
import { z } from "zod";

const dateKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/, "日期必须是 YYYY-MM-DD");
const decimalTextSchema = z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, "金额必须是非负数字且最多两位小数");
const shareRateSchema = z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/, "角色比例格式不正确");
export const financeRoleAssignmentSchema = z.object({
  role: z.enum(["SOURCE", "HANDLING", "CO"]),
  userId: z.string().trim().min(1).max(100),
  shareRate: shareRateSchema
});

export const financeRoleAssignmentsSchema = z.array(financeRoleAssignmentSchema).max(150).superRefine((assignments, context) => {
  const seen = new Set<string>();
  const sharesByRole = new Map<FinanceRole, Prisma.Decimal>();
  for (const [index, assignment] of assignments.entries()) {
    const key = `${assignment.role}:${assignment.userId}`;
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "同一人员不能重复配置同一角色" });
    }
    seen.add(key);
    const share = new Prisma.Decimal(assignment.shareRate);
    if (share.lte(0) || share.gt(1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "shareRate"], message: "角色分配比例须大于 0 且不超过 1" });
    }
    sharesByRole.set(assignment.role, (sharesByRole.get(assignment.role) ?? new Prisma.Decimal(0)).plus(share));
  }
  for (const [role, total] of sharesByRole) {
    if (!total.eq(1)) context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: `${role} 角色人员比例之和必须为 1` });
  }
});

export const financeRuleDefinitionSchema = z
  .object({
    kind: z.string().trim().min(1).max(60),
    calculationBase: z.literal("GROSS").optional(),
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
    if (value.calculationBase === "GROSS") {
      try {
        calculateLawFirmAllocation("100.00", {
          calculationBase: "GROSS",
          channelRate: value.percentages.channelRate,
          firmRate: value.percentages.firmRate,
          roleRates: {
            SOURCE: value.percentages.sourceRate,
            HANDLING: value.percentages.handlingRate,
            CO: value.percentages.coRate
          }
        });
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["percentages"], message: "新版规则比例不完整或不守恒" });
      }
    }
  });

export const financeMatterProfileSchema = z.object({
  matterId: z.string().trim().min(1).max(100),
  origin: z.enum(["DIRECT", "CHANNEL", "SOURCE", "REFERRAL", "OTHER"]),
  lawyerLevel: z.string().trim().max(60).nullish(),
  channelLabel: z.string().trim().max(120).nullish(),
  participantIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  roleAssignments: financeRoleAssignmentsSchema.default([]),
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

export type FinanceRole = "SOURCE" | "HANDLING" | "CO";

export type LawFirmRuleV2 = {
  calculationBase: "GROSS";
  channelRate: string;
  firmRate: string;
  roleRates: Record<FinanceRole, string>;
};

export type LawFirmAllocationV2 = {
  channel: Prisma.Decimal;
  firm: Prisma.Decimal;
  lawyerPool: Prisma.Decimal;
  roles: Record<FinanceRole, Prisma.Decimal>;
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

function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * 律所新版分配：渠道、律所留存和律师池都以本笔净律师费收款总额为基数。
 * 角色比例只拆分律师池；按固定顺序取整，最后一类吸收尾差，确保金额守恒。
 */
export function calculateLawFirmAllocation(grossText: string, rule: LawFirmRuleV2): LawFirmAllocationV2 {
  if (rule.calculationBase !== "GROSS") throw new Error("新版分配基数不受支持");
  const gross = decimal(grossText);
  const channelRate = decimal(rule.channelRate);
  const firmRate = decimal(rule.firmRate);
  const roleRates = {
    SOURCE: decimal(rule.roleRates.SOURCE),
    HANDLING: decimal(rule.roleRates.HANDLING),
    CO: decimal(rule.roleRates.CO)
  } satisfies Record<FinanceRole, Prisma.Decimal>;
  if (gross.lt(0)) throw new Error("分配金额不合法");
  [channelRate, firmRate, ...Object.values(roleRates)].forEach(assertRate);
  if (channelRate.plus(firmRate).gt(1) || !Object.values(roleRates).reduce((sum, rate) => sum.plus(rate), new Prisma.Decimal(0)).eq(1)) {
    throw new Error("分配比例不合法");
  }

  const channel = roundMoney(gross.mul(channelRate));
  const afterChannel = gross.minus(channel);
  const firm = Prisma.Decimal.min(roundMoney(gross.mul(firmRate)), afterChannel);
  const lawyerPool = afterChannel.minus(firm);
  const source = Prisma.Decimal.min(roundMoney(lawyerPool.mul(roleRates.SOURCE)), lawyerPool);
  const handlingRemaining = lawyerPool.minus(source);
  const handling = Prisma.Decimal.min(roundMoney(lawyerPool.mul(roleRates.HANDLING)), handlingRemaining);
  const co = handlingRemaining.minus(handling);
  return { channel, firm, lawyerPool, roles: { SOURCE: source, HANDLING: handling, CO: co } };
}
