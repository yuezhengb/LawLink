import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { linkFinanceRefund } from "@/server/finance/internal-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refundLinkRequestSchema = z.object({
  sourceRowId: z.string().trim().min(1).max(100),
  paymentId: z.string().trim().min(1).max(100),
  amount: z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/),
  reason: z.string().trim().min(1).max(2000)
}).strict();

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const parsed = refundLinkRequestSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: "退款关联信息不完整或格式不正确" }, { status: 400 });
    const result = await linkFinanceRefund(parsed.data, { actor: session.user });
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-refund-links] 失败", caught);
    return NextResponse.json({ error: "退款关联提交失败" }, { status: 500 });
  }
}
