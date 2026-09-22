import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { generateMonthlyClose, getMonthlyCloseStatus } from "@/server/finance/monthly-close";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const period = new URL(req.url).searchParams.get("period") ?? "";
    return NextResponse.json(await getMonthlyCloseStatus(period, { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-monthly-close/status] 失败", caught);
    return NextResponse.json({ error: "月结状态读取失败" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { period?: unknown };
    return NextResponse.json(await generateMonthlyClose(typeof body.period === "string" ? body.period : "", { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-monthly-close/generate] 失败", caught);
    return NextResponse.json({ error: "月结交付包生成失败" }, { status: 500 });
  }
}
