import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { importClaimDecisions } from "@/server/finance/internal-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || typeof file !== "object" || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      return NextResponse.json({ error: "缺少决定文件" }, { status: 400 });
    }
    const result = await importClaimDecisions(file as File, { actor: session.user });
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-reconciliation/import] 失败", caught);
    return NextResponse.json({ error: "对账决定导入失败" }, { status: 500 });
  }
}
