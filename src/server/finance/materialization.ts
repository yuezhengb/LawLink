import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { shDayKey } from "@/lib/ui/sh-time";
import { currentAllocationSourceHash, previewInternalAllocation } from "@/server/finance/internal-allocation";
import type { PrismaClient } from "@prisma/client";

export type FinanceMaterializationActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
export type FinanceMaterializationDependencies = { db?: PrismaClient; actor?: FinanceMaterializationActor };

function periodBounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new ActionError("期间必须是 YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return { start: new Date(`${period}-01T00:00:00+08:00`), end: new Date(`${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00+08:00`) };
}

function actorOrSession(actor?: FinanceMaterializationActor): Promise<FinanceMaterializationActor> {
  if (actor) return Promise.resolve(actor);
  return requireSession("finance.rules").then((session) => ({ id: session.user.id, role: session.user.role, rolePermissions: session.user.rolePermissions }));
}

function assertAccess(actor: FinanceMaterializationActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.rules") === "ALL") return;
  throw new ActionError("无权生成正式财务计算批次");
}

export async function sourceFingerprintForPeriod(
  period: string,
  dependencies: FinanceMaterializationDependencies = {}
): Promise<string> {
  const { start, end } = periodBounds(period);
  return currentAllocationSourceHash({ periodStart: shDayKey(start), periodEnd: shDayKey(end) }, { db: dependencies.db });
}

export async function materializeFinancePeriod(
  input: { period: string },
  dependencies: FinanceMaterializationDependencies = {}
) {
  const actor = await actorOrSession(dependencies.actor);
  assertAccess(actor);
  const bounds = periodBounds(input.period);
  return previewInternalAllocation({ periodStart: shDayKey(bounds.start), periodEnd: shDayKey(bounds.end) }, {
    db: dependencies.db,
    actor
  });
}
