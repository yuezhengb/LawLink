import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  calculateAllocation,
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
});
