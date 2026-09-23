import { describe, expect, it, vi } from "vitest";
import {
  createFinanceRuleDraft,
  publishFinanceRule,
  setFinanceMatterProfile,
  type FinanceRulesDependencies
} from "@/server/finance/internal-rules";

const actor = { id: "synthetic-user-2", role: "FINANCE" } as const;

function mockDeps() {
  const tx = {
    financeRuleSet: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "rule-set-1", kind: "CHANNEL" })
    },
    financeRuleVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "rule-version-1", version: 1 }),
      update: vi.fn().mockResolvedValue({ id: "rule-version-1", version: 2 })
    },
    financeMatterProfile: {
      upsert: vi.fn().mockResolvedValue({ matterId: "matter-1" })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" })
    }
  };
  const db = {
    matter: { findFirst: vi.fn() },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const deps: FinanceRulesDependencies = { db: db as never, actor };
  return { db, tx, deps };
}

const definition = {
  kind: "CHANNEL",
  calculationBase: "GROSS",
  effectiveFrom: "2026-08-01",
  effectiveTo: null,
  percentages: { channelRate: "0.20", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.50", coRate: "0.30" },
  fixedAmounts: {},
  roundingMode: "HALF_UP" as const,
  sourceNote: "合成规则"
};

const legacyDefinition = {
  ...definition,
  calculationBase: undefined,
  percentages: { channelRate: "0.10", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.45", coRate: "0.35" }
};

describe("内部财务规则版本", () => {
  it("创建规则草稿时自动递增版本并保留来源说明", async () => {
    const { tx, deps } = mockDeps();
    const result = await createFinanceRuleDraft({ name: "渠道案规则", definition }, deps);

    expect(result).toEqual({ id: "rule-version-1", version: 1 });
    expect(tx.financeRuleSet.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "CHANNEL" }) }));
    expect(tx.financeRuleVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceNote: "合成规则", publishedAt: null }) })
    );
  });

  it("发布规则检查生效区间并写审计", async () => {
    const { tx, deps } = mockDeps();
    tx.financeRuleVersion.findUnique.mockResolvedValue({
      id: "rule-version-1",
      version: 2,
      ruleSetId: "rule-set-1",
      definition,
      effectiveFrom: new Date("2026-08-01T00:00:00+08:00"),
      effectiveTo: null,
      roundingMode: "HALF_UP",
      sourceNote: "合成规则",
      publishedAt: null
    });

    await expect(publishFinanceRule("rule-version-1", deps)).resolves.toEqual({ id: "rule-version-1", version: 2 });
    expect(tx.financeRuleVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ publishedById: actor.id }) })
    );
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("已发布版本不可再次修改", async () => {
    const { tx, deps } = mockDeps();
    tx.financeRuleVersion.findUnique.mockResolvedValue({ id: "rule-version-1", version: 1, publishedAt: new Date() });

    await expect(publishFinanceRule("rule-version-1", deps)).rejects.toThrow("已发布规则不可修改");
    expect(tx.financeRuleVersion.update).not.toHaveBeenCalled();
  });

  it("旧版比例口径只可读，不允许直接发布成新版规则", async () => {
    const { tx, deps } = mockDeps();
    tx.financeRuleVersion.findUnique.mockResolvedValue({
      id: "rule-version-legacy",
      version: 1,
      ruleSetId: "rule-set-1",
      definition: legacyDefinition,
      effectiveFrom: new Date("2026-08-01T00:00:00+08:00"),
      effectiveTo: null,
      roundingMode: "HALF_UP",
      sourceNote: "历史规则",
      publishedAt: null
    });

    await expect(publishFinanceRule("rule-version-legacy", deps)).rejects.toThrow("请按收款总额基数重新建规则草稿");
    expect(tx.financeRuleVersion.update).not.toHaveBeenCalled();
  });

  it("案件画像只写允许的内部字段并拒绝已删除案件", async () => {
    const { db, tx, deps } = mockDeps();
    db.matter.findFirst.mockResolvedValue({ id: "matter-1" });
    await expect(
      setFinanceMatterProfile({
        matterId: "matter-1",
        origin: "CHANNEL",
        lawyerLevel: "L2",
        channelLabel: "合成渠道",
        participantIds: ["synthetic-user-1"],
        internalNote: "合成备注",
        activeRuleSetId: "rule-set-1"
      }, deps)
    ).resolves.toEqual({ matterId: "matter-1" });
    expect(tx.financeMatterProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { matterId: "matter-1" } }));
  });

  it("案件角色分配拒绝不存在或停用的人员", async () => {
    const { db, tx, deps } = mockDeps();
    db.matter.findFirst.mockResolvedValue({ id: "matter-1" });
    db.user.findMany.mockResolvedValue([]);

    await expect(setFinanceMatterProfile({
      matterId: "matter-1",
      origin: "CHANNEL",
      roleAssignments: [{ role: "SOURCE", userId: "synthetic-missing-user", shareRate: "1" }]
    }, deps)).rejects.toThrow("人员不存在或已停用");
    expect(tx.financeMatterProfile.upsert).not.toHaveBeenCalled();
  });
});
