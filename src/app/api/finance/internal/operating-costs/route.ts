import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { saveFinanceOperatingCost } from "@/server/finance/internal-operating-costs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    return NextResponse.json(await saveFinanceOperatingCost(await req.json(), { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-operating-cost] 失败", caught);
    return NextResponse.json({ error: "律所经营成本保存失败" }, { status: 500 });
  }
}
