import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import type { CommitFinanceImportInput } from "@/lib/finance/internal-types";
import { canManageFinanceImports, commitFinanceImport } from "@/server/finance/internal-imports";
import { financeColumnMappingsBySheetSchema } from "@/server/finance/internal-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!canManageFinanceImports(session.user)) {
    return NextResponse.json({ error: "无财务资料导入权限" }, { status: 403 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") ?? formData.get("sourceFile");
    if (!file || typeof file !== "object" || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      return NextResponse.json({ error: "缺少财务资料文件" }, { status: 400 });
    }
    const upload = file as { name?: unknown; arrayBuffer: () => Promise<ArrayBuffer> };
    const rawKind = formData.get("kind") ?? "BANK_STATEMENT";
    const rawPeriod = formData.get("period");
    const rawAsOfDay = formData.get("asOfDay");
    const rawMappings = formData.get("columnMappingsBySheet");
    let columnMappingsBySheet: CommitFinanceImportInput["columnMappingsBySheet"];
    if (typeof rawMappings === "string" && rawMappings) {
      let parsedMappings: unknown;
      try {
        parsedMappings = JSON.parse(rawMappings);
      } catch {
        return NextResponse.json({ error: "列映射格式不正确" }, { status: 400 });
      }
      const validMappings = financeColumnMappingsBySheetSchema.safeParse(parsedMappings);
      if (!validMappings.success) return NextResponse.json({ error: "列映射格式不正确" }, { status: 400 });
      columnMappingsBySheet = validMappings.data;
    }
    const input: CommitFinanceImportInput = {
      fileName: typeof upload.name === "string" ? upload.name : "finance-import",
      kind: String(rawKind) as CommitFinanceImportInput["kind"],
      bytes: Buffer.from(await upload.arrayBuffer()),
      period: typeof rawPeriod === "string" && rawPeriod ? rawPeriod : undefined,
      asOfDay: typeof rawAsOfDay === "string" && rawAsOfDay ? rawAsOfDay : undefined,
      columnMappingsBySheet
    };
    const result = await commitFinanceImport(input, { actorId: session.user.id });
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 400 });
    console.error("[finance-import/commit] 失败（详细信息已省略）");
    return NextResponse.json({ error: "财务资料提交失败" }, { status: 500 });
  }
}
