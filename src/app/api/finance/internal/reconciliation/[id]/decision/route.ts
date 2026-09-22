import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { decideFinanceReconciliation } from "@/server/finance/internal-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { decision?: unknown; paymentId?: unknown; reason?: unknown };
    const { id } = await params;
    const result = await decideFinanceReconciliation(
      {
        caseId: id,
        decision: body.decision as "CONFIRM" | "IGNORE" | "SUSPECT",
        paymentId: typeof body.paymentId === "string" ? body.paymentId : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined
      },
      { actor: session.user }
    );
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-reconciliation/decision] 失败", caught);
    return NextResponse.json({ error: "对账决定提交失败" }, { status: 500 });
  }
}
