import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { canManageFinanceImports } from "@/server/finance/internal-imports";
import { previewCaseRegisterFile } from "@/server/finance/case-register-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return privateJson({ error: "未登录" }, 401);
  if (!canManageFinanceImports(session.user)) return privateJson({ error: "无财务资料导入权限" }, 403);

  try {
    const form = await request.formData();
    const source = form.get("file");
    if (!source || typeof source !== "object" || typeof (source as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      return privateJson({ error: "缺少案件登记清单文件" }, 400);
    }
    const upload = source as { name?: unknown; size?: unknown; arrayBuffer: () => Promise<ArrayBuffer> };
    if (typeof upload.size === "number" && upload.size > 15 * 1024 * 1024) {
      return privateJson({ error: "案件登记清单超过安全文件大小限制" }, 400);
    }
    const result = await previewCaseRegisterFile({
      fileName: typeof upload.name === "string" ? upload.name : "case-register.xlsx",
      bytes: Buffer.from(await upload.arrayBuffer()),
      actor: session.user
    });
    return privateJson(result);
  } catch (caught) {
    if (caught instanceof ActionError) return privateJson({ error: caught.message }, 400);
    console.error("[finance-case-register/preview] 失败（详细信息已省略）");
    return privateJson({ error: "案件登记清单预览失败" }, 500);
  }
}
