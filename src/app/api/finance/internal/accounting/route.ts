import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { getInternalAccounting } from "@/server/finance/internal-accounting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const period = new URL(req.url).searchParams.get("period") ?? "";
    return NextResponse.json(await getInternalAccounting({ period }, { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-accounting] 失败", caught);
    return NextResponse.json({ error: "内部账读取失败" }, { status: 500 });
  }
}
