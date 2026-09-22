import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { commitInternalAllocation } from "@/server/finance/internal-allocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { runId?: unknown };
    const runId = typeof body.runId === "string" ? body.runId : "";
    return NextResponse.json(await commitInternalAllocation(runId, { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-allocation/commit] 失败", caught);
    return NextResponse.json({ error: "财务分配提交失败" }, { status: 500 });
  }
}
