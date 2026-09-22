import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { exportClaimDecisions } from "@/server/finance/internal-reconciliation";
import type { ReconciliationQuery } from "@/lib/finance/internal-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const url = new URL(req.url);
  const query: ReconciliationQuery = {
    batchId: url.searchParams.get("batchId") || undefined,
    periodStart: url.searchParams.get("periodStart") || undefined,
    periodEnd: url.searchParams.get("periodEnd") || undefined
  };
  try {
    const bytes = await exportClaimDecisions(query, { actor: session.user });
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "attachment; filename*=UTF-8''finance-reconciliation-decisions.csv",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      }
    });
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 403 });
    console.error("[finance-reconciliation/export] 失败", caught);
    return NextResponse.json({ error: "对账决定导出失败" }, { status: 500 });
  }
}
