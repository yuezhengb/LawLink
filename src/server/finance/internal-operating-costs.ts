import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { auditTx } from "@/server/audit";
import type { PrismaClient } from "@prisma/client";

const inputSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  category: z.enum(["RENT", "OFFICE", "TURNOVER_TAX", "OTHER"]),
  amount: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
  sourceRowId: z.string().trim().min(1).nullish(),
  evidenceRef: z.string().trim().max(200).nullish(),
  description: z.string().trim().min(1).max(1000)
});

export type FinanceOperatingCostActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type FinanceOperatingCostDependencies = { db?: PrismaClient; actor?: FinanceOperatingCostActor };

function actorOrSession(actor?: FinanceOperatingCostActor): Promise<FinanceOperatingCostActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.adjust").then((session) => ({ id: session.user.id, role: session.user.role, rolePermissions: session.user.rolePermissions }));
}

function assertWrite(actor: FinanceOperatingCostActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL") return;
  throw new ActionError("无权维护律所经营成本");
}

export async function saveFinanceOperatingCost(input: unknown, dependencies: FinanceOperatingCostDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("律所经营成本信息不完整");
  const data = parsed.data;
  const amount = new Prisma.Decimal(data.amount);
  if (!amount.gt(0)) throw new ActionError("经营成本金额必须大于零");
  if (!data.sourceRowId && !data.evidenceRef?.trim()) throw new ActionError("没有银行来源时必须填写凭据引用");

  const db = dependencies.db ?? prisma;
  return db.$transaction(async (tx) => {
    if (data.sourceRowId) {
      const source = await tx.financeSourceRow.findUnique({
        where: { id: data.sourceRowId },
        include: { batch: { select: { kind: true, status: true } } }
      });
      if (!source || source.batch.kind !== "BANK_STATEMENT" || source.batch.status !== "COMMITTED" || source.direction !== "DEBIT" || !new Prisma.Decimal(source.amount).lt(0) || shDayKey(source.occurredAt).slice(0, 7) !== data.period) {
        throw new ActionError("只能分类同月已归档的银行支出");
      }
      const existing = await tx.financeOperatingCost.findMany({ where: { sourceRowId: data.sourceRowId }, select: { amount: true } });
      const used = existing.reduce((total, cost) => total.plus(cost.amount), new Prisma.Decimal(0));
      if (used.plus(amount).gt(new Prisma.Decimal(source.amount).abs())) throw new ActionError("分类金额超过银行支出余额");
    }

    const saved = await tx.financeOperatingCost.create({
      data: {
        period: data.period,
        category: data.category,
        amount,
        sourceRowId: data.sourceRowId ?? null,
        evidenceRef: data.evidenceRef?.trim() || null,
        description: data.description,
        createdById: actor.id
      },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_OPERATING_COST_CREATE",
      targetType: "FinanceOperatingCost",
      targetId: saved.id,
      detail: { period: data.period, category: data.category, sourceRowId: data.sourceRowId ?? null, evidenceRef: data.evidenceRef ?? null }
    });
    return saved;
  });
}
