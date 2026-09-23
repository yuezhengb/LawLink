import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  calculateAllocation,
  calculateLawFirmAllocation,
  financeMatterProfileSchema,
  financeRuleDefinitionSchema
} from "@/lib/finance/internal-rules";

describe("内部财务分配规则", () => {
  it("渠道案按渠道、律所、案源、承办和协办拆分且金额守恒", () => {
    const result = calculateAllocation({
      gross: "100000.00",
      channelRate: "0.10",
      firmRate: "0.45",
      sourceRate: "0.20",
      handlingRate: "0.45",
      coRate: "0.35"
    });
    const total = result.channel.plus(result.firm).plus(result.source).plus(result.handling).plus(result.co);
    expect(total.toFixed(2)).toBe("100000.00");
    expect(result.channel.gte(0)).toBe(true);
    expect(result.firm.toFixed(2)).toBe("40500.00");
  });

  it("尾差归入协办项且不会产生浮点误差", () => {
    const result = calculateAllocation({
      gross: "100.01",
      channelRate: "0.10",
      firmRate: "0.45",
      sourceRate: "0.20",
      handlingRate: "0.45",
      coRate: "0.35"
    });
    expect(result.channel.plus(result.firm).plus(result.source).plus(result.handling).plus(result.co).eq(new Prisma.Decimal("100.01"))).toBe(true);
  });

  it("新版以收款总额为基数并守恒分配角色池", () => {
    const result = calculateLawFirmAllocation("100000.00", {
      calculationBase: "GROSS",
      channelRate: "0.20",
      firmRate: "0.45",
      roleRates: { SOURCE: "0.20", HANDLING: "0.50", CO: "0.30" }
    });

    expect(result.channel.toFixed(2)).toBe("20000.00");
    expect(result.firm.toFixed(2)).toBe("45000.00");
    expect(result.lawyerPool.toFixed(2)).toBe("35000.00");
    expect(result.roles.SOURCE.toFixed(2)).toBe("7000.00");
    expect(result.roles.HANDLING.toFixed(2)).toBe("17500.00");
    expect(result.roles.CO.toFixed(2)).toBe("10500.00");
    expect(result.channel.plus(result.firm).plus(result.lawyerPool).toFixed(2)).toBe("100000.00");
  });

  it("不同案件类型使用明确留所比例，角色尾差仍由律师池吸收", () => {
    const rule = {
      calculationBase: "GROSS" as const,
      channelRate: "0",
      firmRate: "0.10",
      roleRates: { SOURCE: "0.20", HANDLING: "0.45", CO: "0.35" }
    };
    expect(calculateLawFirmAllocation("100000.00", rule).lawyerPool.toFixed(2)).toBe("90000.00");
    expect(calculateLawFirmAllocation("100.01", { ...rule, firmRate: "0.18" }).lawyerPool.toFixed(2)).toBe("82.01");
    const rounded = calculateLawFirmAllocation("100.01", rule);
    expect(rounded.roles.SOURCE.plus(rounded.roles.HANDLING).plus(rounded.roles.CO).eq(rounded.lawyerPool)).toBe(true);

    const oneCent = calculateLawFirmAllocation("0.01", {
      ...rule,
      channelRate: "0.50",
      firmRate: "0.50"
    });
    expect(oneCent.channel.plus(oneCent.firm).plus(oneCent.lawyerPool).toFixed(2)).toBe("0.01");
    expect(oneCent.lawyerPool.gte(0)).toBe(true);
  });

  it("新版拒绝超额留所、角色比例缺口和负金额", () => {
    const rule = {
      calculationBase: "GROSS" as const,
      channelRate: "0.20",
      firmRate: "0.45",
      roleRates: { SOURCE: "0.20", HANDLING: "0.50", CO: "0.30" }
    };
    expect(() => calculateLawFirmAllocation("100.00", { ...rule, firmRate: "0.90" })).toThrow("分配比例不合法");
    expect(() => calculateLawFirmAllocation("100.00", { ...rule, roleRates: { ...rule.roleRates, CO: "0.20" } })).toThrow("分配比例不合法");
    expect(() => calculateLawFirmAllocation("-1.00", rule)).toThrow("分配金额不合法");
  });

  it("缺少案件来源或比例超过边界时阻断提交", () => {
    expect(() =>
      calculateAllocation({
        gross: "100.00",
        channelRate: "0.10",
        firmRate: "0.95",
        sourceRate: "0.50",
        handlingRate: "0.50",
        coRate: "0.50"
      })
    ).toThrow("分配比例不合法");
  });

  it("规则和案件画像 schema 拒绝过长内部备注与反向日期", () => {
    expect(() =>
      financeRuleDefinitionSchema.parse({
        kind: "CHANNEL",
        effectiveFrom: "2026-09-01",
        effectiveTo: "2026-08-01",
        roundingMode: "HALF_UP",
        sourceNote: "合成规则"
      })
    ).toThrow();
    expect(() =>
      financeMatterProfileSchema.parse({
        matterId: "matter-1",
        origin: "DIRECT",
        participantIds: [],
        internalNote: "x".repeat(1001)
      })
    ).toThrow();
  });

  it("新版规则保留毛额基数并校验渠道、律所和律师角色比例", () => {
    const valid = {
      kind: "CHANNEL",
      calculationBase: "GROSS",
      effectiveFrom: "2026-09-01",
      effectiveTo: null,
      percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
      fixedAmounts: {},
      roundingMode: "HALF_UP",
      sourceNote: "律所内部拟定规则"
    };
    expect(financeRuleDefinitionSchema.parse(valid).calculationBase).toBe("GROSS");
    expect(() => financeRuleDefinitionSchema.parse({ ...valid, percentages: { ...valid.percentages, firmRate: "0.90" } })).toThrow();
    expect(() => financeRuleDefinitionSchema.parse({ ...valid, percentages: { ...valid.percentages, coRate: "0.20" } })).toThrow();
  });

  it("案件角色配置允许多人分工但要求每个角色比例守恒", () => {
    const parsed = financeMatterProfileSchema.parse({
      matterId: "synthetic-matter-1",
      origin: "CHANNEL",
      participantIds: [],
      roleAssignments: [
        { role: "SOURCE", userId: "synthetic-user-1", shareRate: "0.70" },
        { role: "SOURCE", userId: "synthetic-user-2", shareRate: "0.30" },
        { role: "HANDLING", userId: "synthetic-user-1", shareRate: "1" },
        { role: "CO", userId: "synthetic-user-2", shareRate: "1" }
      ]
    });
    expect(parsed.roleAssignments).toHaveLength(4);
    expect(() => financeMatterProfileSchema.parse({
      matterId: "synthetic-matter-1",
      origin: "CHANNEL",
      roleAssignments: [
        { role: "SOURCE", userId: "synthetic-user-1", shareRate: "0.60" },
        { role: "SOURCE", userId: "synthetic-user-2", shareRate: "0.30" }
      ]
    })).toThrow();
  });
});
