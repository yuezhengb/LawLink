import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { createFinanceRuleDraft, setFinanceMatterProfile } from "@/server/finance/internal-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const body = await req.json() as { name?: unknown; ruleSetId?: unknown; definition?: unknown; matterProfile?: unknown };
    if (body.matterProfile) {
      return NextResponse.json(await setFinanceMatterProfile(body.matterProfile, { actor: session.user }));
    }
    return NextResponse.json(await createFinanceRuleDraft({
      name: typeof body.name === "string" ? body.name : "",
      ruleSetId: typeof body.ruleSetId === "string" ? body.ruleSetId : undefined,
      definition: body.definition
    }, { actor: session.user }));
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-rules] 失败", caught);
    return NextResponse.json({ error: "财务规则保存失败" }, { status: 500 });
  }
}
