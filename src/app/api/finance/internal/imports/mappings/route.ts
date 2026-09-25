import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { canManageFinanceImports } from "@/server/finance/internal-imports";
import {
  deleteFinanceImportMappingTemplate,
  listFinanceImportMappingTemplates,
  saveFinanceImportMappingTemplate
} from "@/server/finance/finance-import-mappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStoreJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function authorizedViewer() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return { error: noStoreJson({ error: "未登录" }, 401) };
  if (!canManageFinanceImports(session.user)) return { error: noStoreJson({ error: "无财务资料导入权限" }, 403) };
  return { viewer: session.user };
}

export async function GET(request: Request) {
  const auth = await authorizedViewer();
  if (auth.error) return auth.error;
  try {
    const kind = new URL(request.url).searchParams.get("kind");
    return noStoreJson({ items: await listFinanceImportMappingTemplates(kind, auth.viewer) });
  } catch (caught) {
    if (caught instanceof ActionError) return noStoreJson({ error: caught.message }, 400);
    console.error("[finance-import/mappings] 读取失败");
    return noStoreJson({ error: "映射模板读取失败" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await authorizedViewer();
  if (auth.error) return auth.error;
  try {
    return noStoreJson(await saveFinanceImportMappingTemplate(await request.json(), auth.viewer), 201);
  } catch (caught) {
    if (caught instanceof ActionError) return noStoreJson({ error: caught.message }, 400);
    console.error("[finance-import/mappings] 保存失败");
    return noStoreJson({ error: "映射模板保存失败" }, 500);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizedViewer();
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    await deleteFinanceImportMappingTemplate(body?.id, auth.viewer);
    return noStoreJson({ deleted: true });
  } catch (caught) {
    if (caught instanceof ActionError) return noStoreJson({ error: caught.message }, 400);
    console.error("[finance-import/mappings] 删除失败");
    return noStoreJson({ error: "映射模板删除失败" }, 500);
  }
}
