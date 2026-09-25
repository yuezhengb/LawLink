import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { getFinanceWecomSettings, saveFinanceWecomSettings } from "@/server/finance/finance-wecom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  if (error instanceof ActionError) return NextResponse.json({ error: error.message }, { status: /权限/.test(error.message) ? 403 : 400, headers });
  console.error("[finance-wecom/settings] 失败（详细信息已省略）");
  return NextResponse.json({ error: "财务企微设置读取或保存失败" }, { status: 500, headers });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401, headers });
  try { return NextResponse.json(await getFinanceWecomSettings(session.user), { headers }); }
  catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401, headers });
  try { return NextResponse.json(await saveFinanceWecomSettings(await request.json(), session.user), { headers }); }
  catch (error) { return failure(error); }
}
