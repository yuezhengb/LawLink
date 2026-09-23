import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { buildFirmOperatingResult, buildPersonalDoubleBalance } from "@/lib/finance/internal-accounting";

type OpeningBalance = {
  firstPeriod: string;
  distributable: string;
  reserve: string;
  evidenceRef: string;
};

type PriorSnapshot = {
  period: string;
  distributableEnd: string;
  reserveEnd: string;
};

export type PersonPeriodFacts = {
  userId: string;
  period: string;
  earnedIncome: string;
  selfCostDue: string;
  reserveTargetMonthlyCost?: string;
  selfFundingIn: string;
  withdrawn: string;
  partnerTaxAdvance: string;
  unsettledHold: string;
  openingBalance?: OpeningBalance | null;
  priorSnapshot?: PriorSnapshot | null;
};

export type CalculatedPersonPeriodSnapshot = {
  userId: string;
  period: string;
  openingDistributable: string;
  openingReserve: string;
  earned: string;
  selfCostDue: string;
  selfFundingIn: string;
  selfFundingUsed: string;
  selfCostChargedToIncome: string;
  withdrawn: string;
  partnerTaxAdvance: string;
  unsettledHold: string;
  distributableEnd: string;
  reserveEnd: string;
  reserveGap: string;
};

type FinanceLedgerFact = { userId: string; kind: string; amount: string };
type FinancePayrollFact = {
  userId: string;
  treatmentReviewed: boolean;
  selfCostDue: string;
  firmSalaryCost: string;
  firmSocialCost: string;
  firmFundCost: string;
};
type FinanceAllocationSnapshotLine = {
  grossAmount: string;
  channelAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
  recipients: Array<{ userId: string; amount: string }>;
};
type FinanceCostCategory = "RENT" | "OFFICE" | "TURNOVER_TAX" | "OTHER";

export type FinancePeriodSnapshotInput = {
  period: string;
  allocationLines: FinanceAllocationSnapshotLine[];
  payrollFacts: FinancePayrollFact[];
  ledgerEntries: FinanceLedgerFact[];
  taxRecords: Array<{ userId: string; firmAdvance: string }>;
  openingBalances: Array<OpeningBalance & { userId: string }>;
  priorSnapshots: Array<PriorSnapshot & { userId: string }>;
  operatingCosts: Array<{ category: FinanceCostCategory; amount: string }>;
};

export type FinancePeriodSnapshots = {
  personSnapshots: CalculatedPersonPeriodSnapshot[];
  firmSnapshot: {
    period: string;
    feeRevenue: string;
    channelAmount: string;
    lawyerAmount: string;
    firmSalaryCost: string;
    firmSocialCost: string;
    firmFundCost: string;
    rentCost: string;
    officeCost: string;
    turnoverTaxCost: string;
    otherCost: string;
    operatingResult: string;
  };
};

function sum(values: string[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(fixed(value)), new Prisma.Decimal(0));
}

function moneyString(value: Prisma.Decimal): string {
  if (!value.isFinite()) throw new Error("内账金额不合法");
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function assertNonNegativeFacts(facts: FinanceLedgerFact[], taxRecords: FinancePeriodSnapshotInput["taxRecords"], costs: FinancePeriodSnapshotInput["operatingCosts"]): void {
  if (facts.some((fact) => ["SELF_FUNDING_IN", "INCOME_WITHDRAWAL"].includes(fact.kind) && new Prisma.Decimal(fixed(fact.amount)).lt(0))) {
    throw new Error("预存或收入提款事实不能为负");
  }
  if (taxRecords.some((record) => new Prisma.Decimal(fixed(record.firmAdvance)).lt(0)) || costs.some((cost) => new Prisma.Decimal(fixed(cost.amount)).lt(0))) {
    throw new Error("税款或经营成本事实不能为负");
  }
}

export function calculateFinancePeriodSnapshots(input: FinancePeriodSnapshotInput): FinancePeriodSnapshots {
  assertNonNegativeFacts(input.ledgerEntries, input.taxRecords, input.operatingCosts);
  if (input.payrollFacts.some((fact) => !fact.treatmentReviewed)) throw new Error("工资承担口径尚未复核");

  const payrollByUser = new Map(input.payrollFacts.map((fact) => [fact.userId, fact]));
  const openingByUser = new Map(input.openingBalances.map((balance) => [balance.userId, balance]));
  const priorByUser = new Map(input.priorSnapshots.map((snapshot) => [snapshot.userId, snapshot]));
  const userIds = new Set<string>([
    ...input.allocationLines.flatMap((line) => line.recipients.map((recipient) => recipient.userId)),
    ...input.payrollFacts.map((fact) => fact.userId),
    ...input.ledgerEntries.map((entry) => entry.userId),
    ...input.taxRecords.map((record) => record.userId),
    ...input.openingBalances.map((balance) => balance.userId),
    ...input.priorSnapshots.map((snapshot) => snapshot.userId)
  ]);
  const personSnapshots = [...userIds].sort().map((userId) => {
    const payroll = payrollByUser.get(userId);
    if (!payroll) throw new Error(`缺少人员 ${userId} 本期工资承担确认`);
    const recipientIncome = input.allocationLines.flatMap((line) => line.recipients)
      .filter((recipient) => recipient.userId === userId).map((recipient) => recipient.amount);
    const userLedger = input.ledgerEntries.filter((entry) => entry.userId === userId);
    const taxRecords = input.taxRecords.filter((record) => record.userId === userId);
    return calculatePersonPeriodSnapshot({
      userId,
      period: input.period,
      earnedIncome: moneyString(sum(recipientIncome)),
      selfCostDue: fixed(payroll.selfCostDue),
      reserveTargetMonthlyCost: fixed(payroll.selfCostDue),
      selfFundingIn: moneyString(sum(userLedger.filter((entry) => entry.kind === "SELF_FUNDING_IN").map((entry) => entry.amount))),
      withdrawn: moneyString(sum(userLedger.filter((entry) => entry.kind === "INCOME_WITHDRAWAL").map((entry) => entry.amount))),
      partnerTaxAdvance: moneyString(sum(taxRecords.map((record) => record.firmAdvance))),
      unsettledHold: "0.00",
      openingBalance: openingByUser.get(userId),
      priorSnapshot: priorByUser.get(userId)
    });
  });

  const feeRevenue = sum(input.allocationLines.map((line) => line.grossAmount));
  const channelAmount = sum(input.allocationLines.map((line) => line.channelAmount));
  const lawyerAmount = sum(input.allocationLines.map((line) => sum([line.sourceAmount, line.handlingAmount, line.coAmount]).toFixed(2)));
  const firmSalaryCost = sum(input.payrollFacts.map((fact) => fact.firmSalaryCost));
  const firmSocialCost = sum(input.payrollFacts.map((fact) => fact.firmSocialCost));
  const firmFundCost = sum(input.payrollFacts.map((fact) => fact.firmFundCost));
  const costFor = (category: FinanceCostCategory) => sum(input.operatingCosts.filter((cost) => cost.category === category).map((cost) => cost.amount));
  const rentCost = costFor("RENT");
  const officeCost = costFor("OFFICE");
  const turnoverTaxCost = costFor("TURNOVER_TAX");
  const otherCost = costFor("OTHER");
  const result = buildFirmOperatingResult({
    feeRevenue: feeRevenue.toFixed(2),
    channel: channelAmount.toFixed(2),
    lawyer: lawyerAmount.toFixed(2),
    taxes: turnoverTaxCost.toFixed(2),
    firmSalary: firmSalaryCost.toFixed(2),
    firmSocial: firmSocialCost.toFixed(2),
    firmFund: firmFundCost.toFixed(2),
    rent: rentCost.toFixed(2),
    office: officeCost.toFixed(2),
    otherCosts: otherCost.toFixed(2),
    incomeWithdrawal: "0.00",
    partnerTaxAdvance: "0.00"
  });

  return {
    personSnapshots,
    firmSnapshot: {
      period: input.period,
      feeRevenue: moneyString(feeRevenue),
      channelAmount: moneyString(channelAmount),
      lawyerAmount: moneyString(lawyerAmount),
      firmSalaryCost: moneyString(firmSalaryCost),
      firmSocialCost: moneyString(firmSocialCost),
      firmFundCost: moneyString(firmFundCost),
      rentCost: moneyString(rentCost),
      officeCost: moneyString(officeCost),
      turnoverTaxCost: moneyString(turnoverTaxCost),
      otherCost: moneyString(otherCost),
      operatingResult: result.operatingResult
    }
  };
}

function periodStart(period: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("期间必须是 YYYY-MM");
  return new Date(`${period}-01T00:00:00+08:00`);
}

function previousMonth(period: string): string {
  const date = periodStart(period);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonthStart(period: string): Date {
  return periodStart(previousMonth(period));
}

function toPlainMoney(value: unknown): string {
  return fixed(value instanceof Prisma.Decimal ? value.toFixed(2) : String(value ?? "0.00"));
}

export async function persistFinancePeriodSnapshots(
  runId: string,
  period: string,
  allocationLines: FinanceAllocationSnapshotLine[],
  tx: Prisma.TransactionClient
): Promise<{ personCount: number; firmSnapshot: FinancePeriodSnapshots["firmSnapshot"] }> {
  const start = periodStart(period);
  const [payrollRows, ledgerRows, taxRows, openingRows, priorRun, operatingCostRows] = await Promise.all([
    tx.financePayrollFact.findMany({
      where: { period },
      select: { userId: true, treatmentReviewed: true, selfCostDue: true, firmSalaryCost: true, firmSocialCost: true, firmFundCost: true },
      orderBy: [{ userId: "asc" }, { id: "asc" }]
    }),
    tx.financePersonLedgerEntry.findMany({
      where: { period, kind: { in: ["SELF_FUNDING_IN", "INCOME_WITHDRAWAL"] } },
      select: { targetUserId: true, kind: true, amount: true },
      orderBy: [{ targetUserId: "asc" }, { id: "asc" }]
    }),
    tx.financePartnerTaxRecord.findMany({ where: { period }, select: { userId: true, firmAdvance: true }, orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    tx.financeOpeningBalance.findMany({ where: { firstPeriod: { lte: period } }, select: { userId: true, firstPeriod: true, distributable: true, reserve: true, evidenceRef: true } }),
    tx.financeCalculationRun.findFirst({
      where: { periodStart: previousMonthStart(period), periodEnd: start, status: "COMMITTED", supersededById: null },
      orderBy: { calculatedAt: "desc" },
      include: { personPeriodSnapshots: true }
    }),
    tx.financeOperatingCost.findMany({ where: { period }, select: { category: true, amount: true }, orderBy: [{ category: "asc" }, { id: "asc" }] })
  ]);

  const payrollFacts = payrollRows.map((fact) => ({
    userId: fact.userId,
    treatmentReviewed: fact.treatmentReviewed,
    selfCostDue: toPlainMoney(fact.selfCostDue),
    firmSalaryCost: toPlainMoney(fact.firmSalaryCost),
    firmSocialCost: toPlainMoney(fact.firmSocialCost),
    firmFundCost: toPlainMoney(fact.firmFundCost)
  }));
  const ledgerEntries = ledgerRows.map((entry) => ({ userId: entry.targetUserId, kind: entry.kind, amount: toPlainMoney(entry.amount) }));
  const taxRecords = taxRows.map((record) => ({ userId: record.userId, firmAdvance: toPlainMoney(record.firmAdvance) }));
  const openingBalances = openingRows.map((balance) => ({
    userId: balance.userId,
    firstPeriod: balance.firstPeriod,
    distributable: toPlainMoney(balance.distributable),
    reserve: toPlainMoney(balance.reserve),
    evidenceRef: balance.evidenceRef
  }));
  const priorSnapshots = (priorRun?.personPeriodSnapshots ?? []).map((snapshot) => ({
    userId: snapshot.userId,
    period: snapshot.period,
    distributableEnd: toPlainMoney(snapshot.distributableEnd),
    reserveEnd: toPlainMoney(snapshot.reserveEnd)
  }));
  const operatingCosts = operatingCostRows.map((cost) => ({ category: cost.category, amount: toPlainMoney(cost.amount) })) as FinancePeriodSnapshotInput["operatingCosts"];

  const snapshots = calculateFinancePeriodSnapshots({
    period,
    allocationLines,
    payrollFacts,
    ledgerEntries,
    taxRecords,
    openingBalances,
    priorSnapshots,
    operatingCosts
  });

  if (snapshots.personSnapshots.length > 0) {
    const savedPeople = await tx.financePersonPeriodSnapshot.createMany({
      data: snapshots.personSnapshots.map((snapshot) => ({ ...snapshot, id: randomUUID(), runId }))
    });
    if (savedPeople.count !== snapshots.personSnapshots.length) throw new Error("个人余额快照写入数量不完整");
  }
  await tx.financeFirmPeriodSnapshot.create({
    data: { id: randomUUID(), runId, ...snapshots.firmSnapshot }
  });
  return { personCount: snapshots.personSnapshots.length, firmSnapshot: snapshots.firmSnapshot };
}

function previousPeriod(period: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error("期间必须是 YYYY-MM");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fixed(value: string): string {
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite()) throw new Error("内账金额不合法");
  return decimal.toFixed(2);
}

export function calculatePersonPeriodSnapshot(input: PersonPeriodFacts): CalculatedPersonPeriodSnapshot {
  const lastPeriod = previousPeriod(input.period);
  let openingDistributable: string;
  let openingReserve: string;

  if (input.priorSnapshot) {
    if (input.priorSnapshot.period !== lastPeriod) throw new Error("上期余额快照期间不连续");
    openingDistributable = fixed(input.priorSnapshot.distributableEnd);
    openingReserve = fixed(input.priorSnapshot.reserveEnd);
  } else {
    const opening = input.openingBalance;
    if (!opening || opening.firstPeriod !== input.period || !opening.evidenceRef.trim()) {
      throw new Error(`缺少${input.period}期初余额确认`);
    }
    openingDistributable = fixed(opening.distributable);
    openingReserve = fixed(opening.reserve);
  }

  const balances = buildPersonalDoubleBalance({
    openingDistributable,
    openingReserve,
    earnedIncome: fixed(input.earnedIncome),
    selfCostDue: fixed(input.selfCostDue),
    reserveTargetMonthlyCost: fixed(input.reserveTargetMonthlyCost ?? input.selfCostDue),
    selfFundingIn: fixed(input.selfFundingIn),
    withdrawn: fixed(input.withdrawn),
    partnerTaxAdvance: fixed(input.partnerTaxAdvance),
    unsettledHold: fixed(input.unsettledHold)
  });

  return {
    userId: input.userId,
    period: input.period,
    openingDistributable,
    openingReserve,
    earned: fixed(input.earnedIncome),
    selfCostDue: fixed(input.selfCostDue),
    selfFundingIn: fixed(input.selfFundingIn),
    selfFundingUsed: balances.selfFundingUsed,
    selfCostChargedToIncome: balances.selfCostChargedToIncome,
    withdrawn: fixed(input.withdrawn),
    partnerTaxAdvance: fixed(input.partnerTaxAdvance),
    unsettledHold: fixed(input.unsettledHold),
    distributableEnd: balances.distributableEnd,
    reserveEnd: balances.selfFundingReserveEnd,
    reserveGap: balances.reserveGap
  };
}
