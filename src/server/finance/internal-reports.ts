import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import type { PrismaClient } from "@prisma/client";

export const financeReportQuerySchema = z.object({
  start: z.date(),
  end: z.date(),
  groupBy: z.enum(["LAWYER", "ALL"]).default("ALL")
}).superRefine((value, context) => {
  if (value.end <= value.start) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: "报表结束时间必须晚于开始时间" });
});

export type FinanceReportQuery = z.input<typeof financeReportQuerySchema>;

export type FinanceReportsActor = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceReportsDependencies = {
  db?: PrismaClient;
  actor?: FinanceReportsActor;
};

export type PersonFinanceView = {
  calculationRunId: string;
  userId: string | null;
  userName: string;
  grossIncome: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
};

export type ProjectAttributionLine = {
  sourcePaymentId: string;
  grossAmount: string;
  channelAmount: string;
  firmAmount: string;
  sourceAmount: string;
  handlingAmount: string;
  coAmount: string;
};

export type ProjectAttributionView = {
  calculationRunId: string;
  matterId: string;
  matterCode: string;
  matterTitle: string;
  clientReference: string | null;
  lines: ProjectAttributionLine[];
};

export type FirmOperatingView = {
  calculationRunId: string;
  feeRevenue: string;
  channelAmount: string;
  firmAmount: string;
  lawyerAmount: string;
  operatingResult: string;
};

export type InternalFinanceSummary = {
  calculationRunId: string | null;
  sourcePeriod: { start: string; end: string };
  total: string;
  persons: PersonFinanceView[];
  projects: ProjectAttributionView[];
  firm: FirmOperatingView;
};

function actorOrSession(actor?: FinanceReportsActor): Promise<FinanceReportsActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.read").then((session) => ({
    id: session.user.id,
    role: session.user.role,
    rolePermissions: session.user.rolePermissions
  }));
}

function assertReportsAccess(actor: FinanceReportsActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read")) return;
  throw new ActionError("无财务报表权限");
}

function money(value: unknown): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value ?? "0"));
}

function fixed(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function maskReference(value: string | null | undefined): string | null {
  if (!value) return null;
  return `****${value.slice(-6)}`;
}

function emptySummary(input: { start: Date; end: Date }): InternalFinanceSummary {
  return {
    calculationRunId: null,
    sourcePeriod: { start: shDayKey(input.start), end: shDayKey(input.end) },
    total: "0.00",
    persons: [],
    projects: [],
    firm: { calculationRunId: "", feeRevenue: "0.00", channelAmount: "0.00", firmAmount: "0.00", lawyerAmount: "0.00", operatingResult: "0.00" }
  };
}

export async function getInternalFinanceSummary(
  input: FinanceReportQuery,
  dependencies: FinanceReportsDependencies = {}
): Promise<InternalFinanceSummary> {
  const parsed = financeReportQuerySchema.safeParse(input);
  if (!parsed.success) throw new ActionError("报表期间不正确");
  const actor = await actorOrSession(dependencies.actor);
  assertReportsAccess(actor);
  const db = dependencies.db ?? prisma;
  const linesWhere = {
    matter: {
      deletedAt: null,
      ...matterFinanceVisibilityFilter(actor.id, actor.role, actor.rolePermissions ?? undefined)
    }
  };
  const runs = await db.financeCalculationRun.findMany({
    where: {
      status: "COMMITTED",
      periodStart: { gte: parsed.data.start },
      periodEnd: { lte: parsed.data.end }
    },
    include: {
      allocationLines: {
        where: linesWhere,
        include: {
          matter: { select: { id: true, internalCode: true, title: true, primaryClient: { select: { id: true } } } },
          targetUser: { select: { id: true, name: true } },
          payment: { select: { id: true, occurredAt: true } }
        }
      }
    },
    orderBy: { calculatedAt: "desc" }
  });
  const run = runs.find((candidate) => candidate.status === "COMMITTED");
  if (!run) return emptySummary(parsed.data);

  const allocationLines = run.allocationLines ?? [];
  const total = allocationLines.reduce((sum, line) => sum.plus(money(line.grossAmount)), new Prisma.Decimal(0));
  const personMap = new Map<string, { name: string; gross: Prisma.Decimal; channel: Prisma.Decimal; firm: Prisma.Decimal; source: Prisma.Decimal; handling: Prisma.Decimal; co: Prisma.Decimal }>();
  const projectMap = new Map<string, ProjectAttributionView>();
  let channel = new Prisma.Decimal(0);
  let firm = new Prisma.Decimal(0);
  let lawyer = new Prisma.Decimal(0);

  for (const line of allocationLines) {
    const lineChannel = money(line.channelAmount);
    const lineFirm = money(line.firmAmount);
    const lineSource = money(line.sourceAmount);
    const lineHandling = money(line.handlingAmount);
    const lineCo = money(line.coAmount);
    channel = channel.plus(lineChannel);
    firm = firm.plus(lineFirm);
    lawyer = lawyer.plus(lineSource).plus(lineHandling).plus(lineCo);

    const personKey = line.targetUserId ?? "__UNASSIGNED__";
    const person = personMap.get(personKey) ?? {
      name: line.targetUser?.name ?? "未指定人员",
      gross: new Prisma.Decimal(0),
      channel: new Prisma.Decimal(0),
      firm: new Prisma.Decimal(0),
      source: new Prisma.Decimal(0),
      handling: new Prisma.Decimal(0),
      co: new Prisma.Decimal(0)
    };
    person.gross = person.gross.plus(money(line.grossAmount));
    person.channel = person.channel.plus(lineChannel);
    person.firm = person.firm.plus(lineFirm);
    person.source = person.source.plus(lineSource);
    person.handling = person.handling.plus(lineHandling);
    person.co = person.co.plus(lineCo);
    personMap.set(personKey, person);

    const project = projectMap.get(line.matterId) ?? {
      calculationRunId: run.id,
      matterId: line.matterId,
      matterCode: line.matter?.internalCode ?? "",
      matterTitle: line.matter?.title ?? "",
      clientReference: maskReference(line.matter?.primaryClient?.id),
      lines: []
    };
    project.lines.push({
      sourcePaymentId: line.paymentId,
      grossAmount: fixed(money(line.grossAmount)),
      channelAmount: fixed(lineChannel),
      firmAmount: fixed(lineFirm),
      sourceAmount: fixed(lineSource),
      handlingAmount: fixed(lineHandling),
      coAmount: fixed(lineCo)
    });
    projectMap.set(line.matterId, project);
  }

  const persons = [...personMap.entries()].map(([userId, person]) => ({
    calculationRunId: run.id,
    userId: userId === "__UNASSIGNED__" ? null : userId,
    userName: person.name,
    grossIncome: fixed(person.gross),
    channelAmount: fixed(person.channel),
    firmAmount: fixed(person.firm),
    sourceAmount: fixed(person.source),
    handlingAmount: fixed(person.handling),
    coAmount: fixed(person.co)
  }));
  const firmView: FirmOperatingView = {
    calculationRunId: run.id,
    feeRevenue: fixed(total),
    channelAmount: fixed(channel),
    firmAmount: fixed(firm),
    lawyerAmount: fixed(lawyer),
    operatingResult: fixed(firm)
  };
  return {
    calculationRunId: run.id,
    sourcePeriod: { start: shDayKey(run.periodStart), end: shDayKey(run.periodEnd) },
    total: fixed(total),
    persons,
    projects: [...projectMap.values()],
    firm: firmView
  };
}

export async function getPersonView(input: FinanceReportQuery, dependencies: FinanceReportsDependencies = {}): Promise<PersonFinanceView[]> {
  return (await getInternalFinanceSummary(input, dependencies)).persons;
}

export async function getProjectAttributionView(input: FinanceReportQuery, dependencies: FinanceReportsDependencies = {}): Promise<ProjectAttributionView[]> {
  return (await getInternalFinanceSummary(input, dependencies)).projects;
}

export async function getFirmOperatingView(input: FinanceReportQuery, dependencies: FinanceReportsDependencies = {}): Promise<FirmOperatingView> {
  return (await getInternalFinanceSummary(input, dependencies)).firm;
}
