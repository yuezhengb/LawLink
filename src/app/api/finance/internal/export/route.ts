import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { audit } from "@/server/audit";
import { buildFinanceWorkbook } from "@/server/finance/internal-export";
import type { FinanceReportQuery } from "@/server/finance/internal-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const url = new URL(req.url);
  const periodStart = url.searchParams.get("start");
  const periodEnd = url.searchParams.get("end");
  if (!periodStart || !periodEnd) return NextResponse.json({ error: "必须指定报表期间" }, { status: 400 });
  const input: FinanceReportQuery = {
    start: new Date(`${periodStart}T00:00:00+08:00`),
    end: new Date(`${periodEnd}T00:00:00+08:00`),
    groupBy: url.searchParams.get("groupBy") === "LAWYER" ? "LAWYER" : "ALL"
  };
  try {
    const bytes = await buildFinanceWorkbook(input, { actor: session.user });
    await audit({
      userId: session.user.id,
      action: "FINANCE_INTERNAL_EXPORT",
      targetType: "FinanceWorkbook",
      detail: { periodStart, periodEnd, view: input.groupBy, byteCount: bytes.byteLength }
    });
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''lawlink-finance-${periodStart}-${periodEnd}.xlsx`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      }
    });
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-internal/export] 失败", caught);
    return NextResponse.json({ error: "经营财务工作簿导出失败" }, { status: 500 });
  }
}
