import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { listFinanceReconciliationCases } from "@/server/finance/internal-reconciliation";
import type { FinanceMatchStatus, ReconciliationQuery } from "@/lib/finance/internal-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set<FinanceMatchStatus>(["UNRESOLVED", "SUGGESTED", "CONFIRMED", "IGNORED", "SUSPECT", "EXCEPTION"]);

function queryFromRequest(req: Request): ReconciliationQuery {
  const url = new URL(req.url);
  const statusValue = url.searchParams.get("status") as FinanceMatchStatus | null;
  return {
    batchId: url.searchParams.get("batchId") || undefined,
    status: statusValue && STATUSES.has(statusValue) ? statusValue : undefined,
    periodStart: url.searchParams.get("periodStart") || undefined,
    periodEnd: url.searchParams.get("periodEnd") || undefined,
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? "50")
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    return NextResponse.json(await listFinanceReconciliationCases(queryFromRequest(req), { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 403 });
    console.error("[finance-reconciliation/list] 失败", caught);
    return NextResponse.json({ error: "对账队列读取失败" }, { status: 500 });
  }
}
