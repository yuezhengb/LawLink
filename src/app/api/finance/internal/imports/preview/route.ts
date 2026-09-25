import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { canManageFinanceImports, previewFinanceImport } from "@/server/finance/internal-imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!canManageFinanceImports(session.user)) {
    return NextResponse.json({ error: "无财务资料导入权限" }, { status: 403 });
  }
  try {
    const result = await previewFinanceImport(await req.formData());
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-import/preview] 失败（详细信息已省略）");
    return NextResponse.json({ error: "财务资料预览失败" }, { status: 500 });
  }
}
