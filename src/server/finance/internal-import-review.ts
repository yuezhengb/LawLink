import { z } from "zod";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { scopeFor } from "@/lib/roles/catalog";
import { auditTx } from "@/server/audit";
import { savePayrollFact, type FinanceAccountingActor } from "@/server/finance/internal-accounting-actions";
import type { PrismaClient } from "@prisma/client";

export type FinanceImportReviewActor = FinanceAccountingActor;
export type FinanceImportReviewDependencies = { db?: PrismaClient; actor?: FinanceImportReviewActor };

export type FinanceImportReviewRow = {
  id: string;
  batchId: string;
  batchFileName: string;
  sourceSheet: string;
  sourceRow: number;
  kind: string;
  period: string | null;
  asOfDay: string | null;
  displayName: string | null;
  roleLabel: string | null;
  statement: string | null;
  item: string | null;
  amount: string | null;
  declaredSalary: string | null;
  actualCashPaid: string | null;
  selfCostDue: string | null;
  resolvedUserId: string | null;
  resolvedUserName: string | null;
  reviewStatus: string;
};

function actorOrSession(actor?: FinanceImportReviewActor): Promise<FinanceImportReviewActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.read").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function batchReadScope(actor: FinanceImportReviewActor): "ALL" | "OWN" | null {
  if (actor.role === "FINANCE") return "ALL";
  if (actor.role !== "CUSTOM") return null;
  const grants = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
  if (scopeFor(grants, "finance.read") === "ALL" || scopeFor(grants, "finance.import") === "ALL") return "ALL";
  if (scopeFor(grants, "finance.read") === "OWN") return "OWN";
  return null;
}

export function canReviewFinanceImport(actor: FinanceImportReviewActor): boolean {
  return actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL");
}

function assertRead(actor: FinanceImportReviewActor): void {
  if (!batchReadScope(actor)) throw new ActionError("无权查看内部财务资料");
}

function assertReview(actor: FinanceImportReviewActor): void {
  if (!canReviewFinanceImport(actor)) throw new ActionError("无权复核财务资料");
}

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "object" && "toFixed" in value && typeof value.toFixed === "function"
    ? value.toFixed(2)
    : String(value);
}

export async function listFinanceImportReviews(dependencies: FinanceImportReviewDependencies = {}): Promise<{
  records: FinanceImportReviewRow[];
  users: Array<{ id: string; name: string; role: string }>;
}> {
  const actor = await actorOrSession(dependencies.actor);
  const scope = batchReadScope(actor);
  if (!scope) assertRead(actor);
  const db = dependencies.db ?? prisma;
  const [rows, users] = await Promise.all([
    db.financeImportRecord.findMany({
      where: { batch: { status: "COMMITTED", ...(scope === "OWN" ? { createdById: actor.id } : {}) } },
      orderBy: [{ batch: { createdAt: "desc" } }, { sourceRow: "asc" }],
      take: 200,
      select: {
        id: true, batchId: true, sourceSheet: true, sourceRow: true, kind: true, period: true, asOfDay: true, displayName: true, roleLabel: true,
        statement: true, item: true, amount: true, declaredSalary: true, actualCashPaid: true, selfCostDue: true,
        resolvedUserId: true, reviewStatus: true,
        batch: { select: { fileName: true } },
        resolvedUser: { select: { name: true } }
      }
    }),
    canReviewFinanceImport(actor)
      ? db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, role: true } })
      : Promise.resolve([])
  ]);
  return {
    records: rows.map((row) => ({
      id: row.id,
      batchId: row.batchId,
      batchFileName: row.batch.fileName,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
      kind: String(row.kind),
      period: row.period,
      asOfDay: row.asOfDay?.toISOString().slice(0, 10) ?? null,
      displayName: row.displayName,
      roleLabel: row.roleLabel,
      statement: row.statement ? String(row.statement) : null,
      item: row.item,
      amount: decimalText(row.amount),
      declaredSalary: decimalText(row.declaredSalary),
      actualCashPaid: decimalText(row.actualCashPaid),
      selfCostDue: decimalText(row.selfCostDue),
      resolvedUserId: row.resolvedUserId,
      resolvedUserName: row.resolvedUser?.name ?? null,
      reviewStatus: String(row.reviewStatus)
    })),
    users: users.map((user) => ({ ...user, role: String(user.role) }))
  };
}

const resolveSchema = z.object({
  id: z.string().trim().min(1).max(100),
  targetUserId: z.string().trim().min(1).max(100).nullable()
}).strict();

function requiredAmount(value: unknown, label: string): string {
  const amount = decimalText(value);
  if (amount === null) throw new ActionError(`工资资料缺少${label}，不能确认入账`);
  return amount;
}

export async function resolveFinanceImportRecord(
  id: string,
  targetUserId: string | null,
  dependencies: FinanceImportReviewDependencies = {}
): Promise<{ id: string; kind: string; reviewStatus: "RESOLVED"; payrollFactId: string | null; duplicate: boolean }> {
  const actor = await actorOrSession(dependencies.actor);
  assertReview(actor);
  const input = resolveSchema.safeParse({ id, targetUserId });
  if (!input.success) throw new ActionError("复核目标不正确");
  const db = dependencies.db ?? prisma;
  const current = await db.financeImportRecord.findUnique({ where: { id: input.data.id }, include: { batch: { select: { status: true } } } });
  if (!current || current.batch.status !== "COMMITTED") throw new ActionError("财务资料记录不存在或来源尚未归档");
  const kind = String(current.kind);
  if (!(kind === "PAYROLL" || kind === "ROSTER" || kind === "EXTERNAL_THREE_STATEMENTS")) throw new ActionError("该资料类型不支持此复核操作");
  const assignedUserId = input.data.targetUserId;
  if (kind === "EXTERNAL_THREE_STATEMENTS" ? assignedUserId !== null : !assignedUserId) {
    throw new ActionError(kind === "EXTERNAL_THREE_STATEMENTS" ? "外部报表核对不需要关联人员" : "请先选择对应的在职人员");
  }

  if (current.reviewStatus === "RESOLVED") {
    if (current.resolvedUserId !== assignedUserId) throw new ActionError("已复核记录不能重新关联，请通过财务更正流程处理");
    const existingPayroll = kind === "PAYROLL" && current.period && assignedUserId
      ? await db.financePayrollFact.findUnique({ where: { userId_period: { userId: assignedUserId, period: current.period } }, select: { id: true } })
      : null;
    return { id: current.id, kind, reviewStatus: "RESOLVED", payrollFactId: existingPayroll?.id ?? null, duplicate: true };
  }
  if (current.reviewStatus !== "NEEDS_REVIEW") throw new ActionError("该资料记录当前状态不能复核");
  if (assignedUserId) {
    const activeUser = await db.user.findFirst({ where: { id: assignedUserId, active: true }, select: { id: true } });
    if (!activeUser) throw new ActionError("人员不存在或已停用");
  }

  return db.$transaction(async (tx) => {
    const record = await tx.financeImportRecord.findUnique({ where: { id }, include: { batch: { select: { status: true } } } });
    if (!record || record.batch.status !== "COMMITTED") throw new ActionError("财务资料记录不存在或来源尚未归档");
    if (record.reviewStatus === "RESOLVED") {
      if (record.resolvedUserId !== assignedUserId) throw new ActionError("该资料已由其他操作完成复核，请刷新后查看");
      const existingPayroll = kind === "PAYROLL" && record.period && assignedUserId
        ? await tx.financePayrollFact.findUnique({ where: { userId_period: { userId: assignedUserId, period: record.period } }, select: { id: true } })
        : null;
      return { id: record.id, kind, reviewStatus: "RESOLVED" as const, payrollFactId: existingPayroll?.id ?? null, duplicate: true };
    }
    if (record.reviewStatus !== "NEEDS_REVIEW") throw new ActionError("该资料记录当前状态不能复核");

    if (assignedUserId) {
      const activeUser = await tx.user.findFirst({ where: { id: assignedUserId, active: true }, select: { id: true } });
      if (!activeUser) throw new ActionError("人员不存在或已停用");
    }

    let payrollFactId: string | null = null;
    if (kind === "PAYROLL") {
      if (!record.period || !assignedUserId) throw new ActionError("工资账期或人员信息缺失");
      const existingPayroll = await tx.financePayrollFact.findUnique({ where: { userId_period: { userId: assignedUserId, period: record.period } }, select: { id: true } });
      if (existingPayroll) throw new ActionError("该人员本期已有工资事实；请先核对后再通过修订流程更新");
      const saved = await savePayrollFact({
        userId: assignedUserId,
        period: record.period,
        grossSalary: requiredAmount(record.declaredSalary, "申报工资"),
        commission: "0.00",
        socialPersonal: "0.00",
        socialCompany: "0.00",
        fundPersonal: "0.00",
        fundCompany: "0.00",
        incomeTax: "0.00",
        otherDeduction: "0.00",
        reimbursement: "0.00",
        isDeemedWage: false,
        actualCashPaid: requiredAmount(record.actualCashPaid, "实际支付"),
        selfCostDue: requiredAmount(record.selfCostDue, "个人自担成本"),
        firmSalaryCost: "0.00",
        firmSocialCost: "0.00",
        firmFundCost: "0.00",
        treatmentReviewed: false,
        treatmentNote: "由工资表归档并人工关联；工资、社保、公积金承担口径仍待复核。",
        sourceBatchId: record.batchId
      }, { db, tx, actor });
      payrollFactId = saved.id;
    }

    await tx.financeImportRecord.update({
      where: { id: record.id },
      data: { resolvedUserId: assignedUserId, reviewStatus: "RESOLVED" },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_IMPORT_RECORD_RESOLVE",
      targetType: "FinanceImportRecord",
      targetId: record.id,
      detail: { kind, batchId: record.batchId, sourceRow: record.sourceRow, userId: assignedUserId, payrollFactId }
    });
    return { id: record.id, kind, reviewStatus: "RESOLVED", payrollFactId, duplicate: false };
  });
}
