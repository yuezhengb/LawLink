import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import type { FinanceDirection, FinanceReconciliationStatus } from "@prisma/client";
import { listFinanceCounterparties } from "@/server/finance/internal-finance-workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const url = new URL(request.url);
  try {
    const result = await listFinanceCounterparties({
      period: url.searchParams.get("period") ?? "",
      direction: (url.searchParams.get("direction") || undefined) as FinanceDirection | undefined,
      status: (url.searchParams.get("status") || undefined) as FinanceReconciliationStatus | undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      pageSize: Number(url.searchParams.get("pageSize") ?? "50")
    }, session.user);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
    console.error("[finance-counterparties/list] 失败（详细信息已省略）");
    return NextResponse.json({ error: "往来单位透视读取失败" }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
