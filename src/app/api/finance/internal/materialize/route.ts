import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { materializeFinancePeriod } from "@/server/finance/materialization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { period?: unknown };
    return NextResponse.json(await materializeFinancePeriod({ period: typeof body.period === "string" ? body.period : "" }, { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-materialize] 失败", caught);
    return NextResponse.json({ error: "财务计算批次生成失败" }, { status: 500 });
  }
}
