import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { FinanceImportForbiddenError, FinanceImportNotFoundError, previewFinanceImportSource } from "@/server/finance/internal-imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" }
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return privateJson({ error: "未登录" }, 401);
  const { id } = await params;
  const url = new URL(request.url);
  const sheetIndex = Number(url.searchParams.get("sheet") ?? "0");
  const page = Number(url.searchParams.get("page") ?? "1");

  try {
    const result = await previewFinanceImportSource(id, session.user, { sheetIndex, page });
    return privateJson(result);
  } catch (caught) {
    if (caught instanceof FinanceImportNotFoundError) return privateJson({ error: caught.message }, 404);
    if (caught instanceof FinanceImportForbiddenError) return privateJson({ error: caught.message }, 403);
    console.error("[finance-import/preview] 来源预览失败（来源内容已省略）");
    return privateJson({ error: "来源数据预览失败" }, 500);
  }
}
