import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { financeMatterProfileSchema, financeRuleDefinitionSchema } from "@/lib/finance/internal-rules";
import type { PrismaClient } from "@prisma/client";

export type FinanceRulesActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceRulesDependencies = {
  db?: PrismaClient;
  actor?: FinanceRulesActor;
};

export type FinanceRuleDraftInput = {
  name: string;
  ruleSetId?: string;
  definition: unknown;
};

function actorOrSession(actor?: FinanceRulesActor): Promise<FinanceRulesActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.rules").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function canManageRules(actor: FinanceRulesActor): boolean {
  return actor.role === "FINANCE" ||
    (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.rules") === "ALL");
}

function assertManageRules(actor: FinanceRulesActor): void {
  if (!canManageRules(actor)) throw new ActionError("无权维护内部财务规则");
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

export async function createFinanceRuleDraft(
  input: FinanceRuleDraftInput,
  dependencies: FinanceRulesDependencies = {}
): Promise<{ id: string; version: number }> {
  const actor = await actorOrSession(dependencies.actor);
  assertManageRules(actor);
  const definition = financeRuleDefinitionSchema.safeParse(input.definition);
  if (!definition.success) throw new ActionError("规则定义不完整或日期区间不合法");
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ActionError("规则名称不正确");
  const db = dependencies.db ?? prisma;

  return db.$transaction(async (tx) => {
    let ruleSet = input.ruleSetId
      ? await tx.financeRuleSet.findUnique({ where: { id: input.ruleSetId }, select: { id: true, kind: true } })
      : null;
    if (input.ruleSetId && !ruleSet) throw new ActionError("规则集不存在");
    if (!ruleSet) {
      ruleSet = await tx.financeRuleSet.create({
        data: { name, kind: definition.data.kind, createdById: actor.id },
        select: { id: true, kind: true }
      });
    }
    if (ruleSet.kind !== definition.data.kind) throw new ActionError("规则集类型与规则定义不一致");
    const latest = await tx.financeRuleVersion.findFirst({
      where: { ruleSetId: ruleSet.id },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    const version = (latest?.version ?? 0) + 1;
    const created = await tx.financeRuleVersion.create({
      data: {
        ruleSetId: ruleSet.id,
        version,
        definition: definition.data,
        effectiveFrom: dayStart(definition.data.effectiveFrom),
        effectiveTo: definition.data.effectiveTo ? dayStart(definition.data.effectiveTo) : null,
        roundingMode: definition.data.roundingMode,
        sourceNote: definition.data.sourceNote,
        publishedAt: null
      },
      select: { id: true, version: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_RULE_DRAFT_CREATE",
      targetType: "FinanceRuleVersion",
      targetId: created.id,
      detail: { ruleSetId: ruleSet.id, version: created.version, kind: definition.data.kind }
    });
    return created;
  });
}

export async function publishFinanceRule(
  id: string,
  dependencies: FinanceRulesDependencies = {}
): Promise<{ id: string; version: number }> {
  const actor = await actorOrSession(dependencies.actor);
  assertManageRules(actor);
  const db = dependencies.db ?? prisma;

  return db.$transaction(async (tx) => {
    const version = await tx.financeRuleVersion.findUnique({ where: { id } });
    if (!version) throw new ActionError("规则版本不存在");
    if (version.publishedAt) throw new ActionError("已发布规则不可修改");
    const definition = financeRuleDefinitionSchema.safeParse(version.definition);
    if (!definition.success) throw new ActionError("规则定义不完整或日期区间不合法");
    if (definition.data.calculationBase !== "GROSS") throw new ActionError("请按收款总额基数重新建规则草稿");
    const overlap = await tx.financeRuleVersion.findFirst({
      where: {
        ruleSetId: version.ruleSetId,
        id: { not: id },
        publishedAt: { not: null },
        effectiveFrom: { lt: version.effectiveTo ?? new Date("9999-12-31T00:00:00.000Z") },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gt: version.effectiveFrom } }
        ]
      },
      select: { id: true }
    });
    if (overlap) throw new ActionError("同一规则集的生效区间重叠，不能发布");

    const published = await tx.financeRuleVersion.update({
      where: { id },
      data: { publishedAt: new Date(), publishedById: actor.id },
      select: { id: true, version: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_RULE_PUBLISH",
      targetType: "FinanceRuleVersion",
      targetId: id,
      detail: { ruleSetId: version.ruleSetId, version: version.version, kind: definition.data.kind }
    });
    return published;
  });
}

export async function setFinanceMatterProfile(
  input: unknown,
  dependencies: FinanceRulesDependencies = {}
): Promise<{ matterId: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertManageRules(actor);
  const parsed = financeMatterProfileSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("案件财务画像不完整");
  const data = parsed.data;
  const db = dependencies.db ?? prisma;
  const matter = await db.matter.findFirst({ where: { id: data.matterId, deletedAt: null }, select: { id: true } });
  if (!matter) throw new ActionError("案件不存在或已删除");
  if (data.roleAssignments.length) {
    const userIds = [...new Set(data.roleAssignments.map((assignment) => assignment.userId))];
    const users = await db.user.findMany({ where: { id: { in: userIds }, active: true }, select: { id: true } });
    const activeUserIds = new Set(users.map((user) => user.id));
    if (userIds.some((userId) => !activeUserIds.has(userId))) throw new ActionError("人员不存在或已停用，不能配置案件分配");
  }

  return db.$transaction(async (tx) => {
    const profile = await tx.financeMatterProfile.upsert({
      where: { matterId: data.matterId },
      create: {
        matterId: data.matterId,
        origin: data.origin,
        lawyerLevel: data.lawyerLevel ?? null,
        channelLabel: data.channelLabel ?? null,
        participantIds: data.participantIds,
        roleAssignments: data.roleAssignments,
        internalNote: data.internalNote ?? null,
        activeRuleSetId: data.activeRuleSetId ?? null,
        updatedById: actor.id
      },
      update: {
        origin: data.origin,
        lawyerLevel: data.lawyerLevel ?? null,
        channelLabel: data.channelLabel ?? null,
        participantIds: data.participantIds,
        roleAssignments: data.roleAssignments,
        internalNote: data.internalNote ?? null,
        activeRuleSetId: data.activeRuleSetId ?? null,
        updatedById: actor.id
      },
      select: { matterId: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_MATTER_PROFILE_UPSERT",
      targetType: "FinanceMatterProfile",
      targetId: profile.matterId,
      detail: { matterId: profile.matterId, origin: data.origin, activeRuleSetId: data.activeRuleSetId ?? null }
    });
    return profile;
  });
}
