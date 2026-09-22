import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { reverseFinanceAdjustment } from "@/server/finance/monthly-close";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { note?: unknown };
    const { id } = await params;
    return NextResponse.json(await reverseFinanceAdjustment(id, typeof body.note === "string" ? body.note : "", { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-adjustments/reverse] 失败", caught);
    return NextResponse.json({ error: "财务调整冲销失败" }, { status: 500 });
  }
}
