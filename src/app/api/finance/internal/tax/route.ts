import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { savePartnerTaxRecord } from "@/server/finance/internal-accounting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    return NextResponse.json(await savePartnerTaxRecord(await req.json(), { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-tax] 失败", caught);
    return NextResponse.json({ error: "合伙人税款保存失败" }, { status: 500 });
  }
}
