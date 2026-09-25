import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { sendFinanceWecomNotification } from "@/server/finance/finance-wecom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401, headers });
  try {
    const body = await request.json() as { period?: unknown; confirmed?: unknown };
    if (typeof body?.period !== "string" || body.confirmed !== true) {
      return NextResponse.json({ error: "发送前必须指定期间并明确确认" }, { status: 400, headers });
    }
    return NextResponse.json(await sendFinanceWecomNotification({ period: body.period, confirmed: true }, session.user), { headers });
  } catch (error) {
    if (error instanceof ActionError) return NextResponse.json({ error: error.message }, { status: /权限/.test(error.message) ? 403 : 400, headers });
    console.error("[finance-wecom/send] 失败（详细信息已省略）");
    return NextResponse.json({ error: "财务企微摘要发送失败" }, { status: 500, headers });
  }
}
