import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import type { PrismaClient } from "@prisma/client";

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "期间必须是 YYYY-MM");
const moneySchema = z.string().trim().regex(/^-?\d+(?:\.\d{1,2})?$/, "金额最多保留两位小数");
const nonNegativeMoneySchema = z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, "金额必须是非负数，最多保留两位小数");

const payrollSchema = z.object({
  userId: z.string().trim().min(1),
  period: periodSchema,
  grossSalary: nonNegativeMoneySchema,
  commission: nonNegativeMoneySchema,
  socialPersonal: nonNegativeMoneySchema,
  socialCompany: nonNegativeMoneySchema,
  fundPersonal: nonNegativeMoneySchema,
  fundCompany: nonNegativeMoneySchema,
  incomeTax: nonNegativeMoneySchema,
  otherDeduction: nonNegativeMoneySchema,
  reimbursement: nonNegativeMoneySchema,
  isDeemedWage: z.boolean().default(false),
  actualCashPaid: nonNegativeMoneySchema.default("0.00"),
  selfCostDue: nonNegativeMoneySchema.default("0.00"),
  firmSalaryCost: nonNegativeMoneySchema.default("0.00"),
  firmSocialCost: nonNegativeMoneySchema.default("0.00"),
  firmFundCost: nonNegativeMoneySchema.default("0.00"),
  treatmentReviewed: z.boolean().default(false),
  treatmentNote: z.string().trim().max(1000).nullish(),
  actualPaymentPeriod: periodSchema.nullish(),
  sourceBatchId: z.string().trim().max(100).nullish()
});

const taxSchema = z.object({
  userId: z.string().trim().min(1),
  period: periodSchema,
  estimatedTax: nonNegativeMoneySchema,
  firmAdvance: nonNegativeMoneySchema,
  personallyPaid: nonNegativeMoneySchema,
  personallyPaidAt: z.coerce.date().nullish(),
  phase: z.enum(["ESTIMATED", "ADVANCED", "PERSONALLY_PAID", "SETTLED"]),
  evidenceRef: z.string().trim().max(200).nullish()
});

const openingBalanceSchema = z.object({
  userId: z.string().trim().min(1),
  firstPeriod: periodSchema,
  distributable: moneySchema,
  reserve: nonNegativeMoneySchema,
  evidenceRef: z.string().trim().min(1).max(200)
});

const capitalSchema = z.object({
  investorId: z.string().trim().min(1),
  period: periodSchema,
  amount: nonNegativeMoneySchema,
  kind: z.enum(["CAPITAL_IN", "CAPITAL_OUT", "INCOME_WITHDRAWAL"]),
  throughPartnerId: z.string().trim().min(1).nullish(),
  linkedBankSourceRowId: z.string().trim().min(1).nullish(),
  remarks: z.string().trim().max(1000).nullish()
});

const personalLedgerEntrySchema = z.object({
  targetUserId: z.string().trim().min(1),
  period: periodSchema,
  kind: z.enum(["SELF_FUNDING_IN", "INCOME_WITHDRAWAL"]),
  amount: nonNegativeMoneySchema,
  sourceRef: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).nullish()
});

export type FinanceAccountingActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceAccountingDependencies = {
  db?: PrismaClient;
  tx?: Prisma.TransactionClient;
  actor?: FinanceAccountingActor;
};

export type InternalAccountingView = {
  period: string;
  payrollFacts: unknown[];
  taxRecords: unknown[];
  capitalFlows: unknown[];
  ledgerEntries: unknown[];
  adjustments: unknown[];
};

function actorOrSession(actor?: FinanceAccountingActor): Promise<FinanceAccountingActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.adjust").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function canWrite(actor: FinanceAccountingActor): boolean {
  return actor.role === "FINANCE" ||
    (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL");
}

function canRead(actor: FinanceAccountingActor): boolean {
  return actor.role === "FINANCE" ||
    (actor.role === "CUSTOM" && Boolean(scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read")));
}

function assertWrite(actor: FinanceAccountingActor): void {
  if (!canWrite(actor)) throw new ActionError("无权维护工资、税款或资本事实");
}

function assertRead(actor: FinanceAccountingActor): void {
  if (!canRead(actor)) throw new ActionError("无权查看内部财务账");
}

async function assertActiveUser(db: PrismaClient, userId: string): Promise<void> {
  const user = await db.user.findFirst({ where: { id: userId, active: true }, select: { id: true } });
  if (!user) throw new ActionError("人员不存在或已停用");
}

const PAYROLL_REVISION_FIELDS = [
  "period", "grossSalary", "commission", "socialPersonal", "socialCompany", "fundPersonal", "fundCompany",
  "incomeTax", "otherDeduction", "reimbursement", "isDeemedWage", "actualCashPaid", "selfCostDue",
  "firmSalaryCost", "firmSocialCost", "firmFundCost", "treatmentReviewed", "treatmentNote", "actualPaymentPeriod", "sourceBatchId"
] as const;

function payrollRevisionSnapshot(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(PAYROLL_REVISION_FIELDS.map((field) => {
    const current = value[field];
    return [field, current instanceof Prisma.Decimal ? current.toFixed(2) : current ?? null];
  })) as Prisma.InputJsonObject;
}

export async function savePayrollFact(input: unknown, dependencies: FinanceAccountingDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = payrollSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("工资事实不完整");
  const data = parsed.data;
  if (data.isDeemedWage && new Prisma.Decimal(data.actualCashPaid).gt(0)) throw new ActionError("视同工资不能登记实际支付");
  const db = dependencies.db ?? prisma;
  await assertActiveUser(db, data.userId);
  const persist = async (tx: Prisma.TransactionClient) => {
    const existing = await tx.financePayrollFact.findUnique({ where: { userId_period: { userId: data.userId, period: data.period } } });
    const version = (existing?.revision ?? 0) + 1;
    const sourceBatchId = data.sourceBatchId ?? existing?.sourceBatchId ?? null;
    const savedData = { ...data, sourceBatchId };
    const saved = await tx.financePayrollFact.upsert({
      where: { userId_period: { userId: data.userId, period: data.period } },
      create: { ...savedData, revision: version, createdById: actor.id },
      update: { ...savedData, revision: { increment: 1 } },
      select: { id: true }
    });
    await tx.financePayrollFactRevision.create({
      data: {
        payrollFactId: saved.id,
        version,
        before: existing ? payrollRevisionSnapshot(existing) : undefined,
        after: payrollRevisionSnapshot(savedData),
        changedById: actor.id
      }
    });
    await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_PAYROLL_UPSERT", targetType: "FinancePayrollFact", targetId: saved.id, detail: { userId: data.userId, period: data.period, revision: version, sourceBatchId } });
    return saved;
  };
  return dependencies.tx ? persist(dependencies.tx) : db.$transaction(persist);
}

export async function saveOpeningBalance(input: unknown, dependencies: FinanceAccountingDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = openingBalanceSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("期初余额确认信息不完整");
  const data = parsed.data;
  const db = dependencies.db ?? prisma;
  await assertActiveUser(db, data.userId);
  return db.$transaction(async (tx) => {
    const existing = await tx.financeOpeningBalance.findUnique({ where: { userId: data.userId }, select: { id: true } });
    if (existing) throw new ActionError("期初余额已确认且不可覆盖");
    const saved = await tx.financeOpeningBalance.create({
      data: {
        ...data,
        confirmedById: actor.id
      },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_OPENING_BALANCE_CREATE",
      targetType: "FinanceOpeningBalance",
      targetId: saved.id,
      detail: { userId: data.userId, firstPeriod: data.firstPeriod, evidenceRef: data.evidenceRef }
    });
    return saved;
  });
}

export async function savePersonalLedgerEntry(input: unknown, dependencies: FinanceAccountingDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = personalLedgerEntrySchema.safeParse(input);
  if (!parsed.success) throw new ActionError("个人内账事件信息不完整");
  const data = parsed.data;
  const amount = new Prisma.Decimal(data.amount);
  if (!amount.gt(0)) throw new ActionError("预存或提款金额必须大于零");
  const db = dependencies.db ?? prisma;
  await assertActiveUser(db, data.targetUserId);
  return db.$transaction(async (tx) => {
    const duplicate = await tx.financePersonLedgerEntry.findFirst({
      where: { targetUserId: data.targetUserId, period: data.period, kind: data.kind, sourceRef: data.sourceRef },
      select: { id: true }
    });
    if (duplicate) throw new ActionError("该来源已记入个人内账");
    const saved = await tx.financePersonLedgerEntry.create({
      data: { targetUserId: data.targetUserId, period: data.period, kind: data.kind, amount, sourceRef: data.sourceRef, note: data.note ?? null, createdById: actor.id },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: actor.id,
      action: "FINANCE_INTERNAL_PERSON_LEDGER_CREATE",
      targetType: "FinancePersonLedgerEntry",
      targetId: saved.id,
      detail: { userId: data.targetUserId, period: data.period, kind: data.kind, sourceRef: data.sourceRef }
    });
    return saved;
  });
}

export async function savePartnerTaxRecord(input: unknown, dependencies: FinanceAccountingDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = taxSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("合伙人税款事实不完整");
  const data = parsed.data;
  const db = dependencies.db ?? prisma;
  await assertActiveUser(db, data.userId);
  return db.$transaction(async (tx) => {
    const saved = await tx.financePartnerTaxRecord.create({ data: { ...data, createdById: actor.id }, select: { id: true } });
    await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_PARTNER_TAX_CREATE", targetType: "FinancePartnerTaxRecord", targetId: saved.id, detail: { userId: data.userId, period: data.period, phase: data.phase } });
    return saved;
  });
}

export async function saveCapitalFlow(input: unknown, dependencies: FinanceAccountingDependencies = {}): Promise<{ id: string }> {
  const actor = await actorOrSession(dependencies.actor);
  assertWrite(actor);
  const parsed = capitalSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("资本流水信息不完整");
  const data = parsed.data;
  const db = dependencies.db ?? prisma;
  await assertActiveUser(db, data.investorId);
  if (data.throughPartnerId) await assertActiveUser(db, data.throughPartnerId);
  return db.$transaction(async (tx) => {
    const saved = await tx.financeCapitalFlow.create({ data: { ...data, createdById: actor.id }, select: { id: true } });
    await auditTx(tx, { userId: actor.id, action: "FINANCE_INTERNAL_CAPITAL_CREATE", targetType: "FinanceCapitalFlow", targetId: saved.id, detail: { investorId: data.investorId, period: data.period, kind: data.kind, amount: data.amount } });
    return saved;
  });
}

export async function getInternalAccounting(input: { period: string }, dependencies: FinanceAccountingDependencies = {}): Promise<InternalAccountingView> {
  const actor = await actorOrSession(dependencies.actor);
  assertRead(actor);
  const period = periodSchema.safeParse(input.period);
  if (!period.success) throw new ActionError("期间必须是 YYYY-MM");
  const db = dependencies.db ?? prisma;
  const [payrollFacts, taxRecords, capitalFlows, ledgerEntries, adjustments] = await Promise.all([
    db.financePayrollFact.findMany({ where: { period: period.data }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financePartnerTaxRecord.findMany({ where: { period: period.data }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    db.financeCapitalFlow.findMany({ where: { period: period.data }, orderBy: [{ investorId: "asc" }, { id: "asc" }] }),
    db.financePersonLedgerEntry.findMany({ where: { period: period.data }, orderBy: [{ targetUserId: "asc" }, { id: "asc" }] }),
    db.financeAdjustment.findMany({ where: { period: period.data }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  ]);
  return { period: period.data, payrollFacts, taxRecords, capitalFlows, ledgerEntries, adjustments };
}
