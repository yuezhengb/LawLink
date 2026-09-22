import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import {
  downloadFinanceImportSource,
  FinanceImportForbiddenError,
  FinanceImportNotFoundError
} from "@/server/finance/internal-imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { id } = await params;

  try {
    const result = await downloadFinanceImportSource(id, session.user);
    const arrayBuffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength
    ) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.bytes.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      }
    });
  } catch (caught) {
    if (caught instanceof FinanceImportNotFoundError) return NextResponse.json({ error: caught.message }, { status: 404 });
    if (caught instanceof FinanceImportForbiddenError) return NextResponse.json({ error: caught.message }, { status: 403 });
    console.error("[finance-import/source] 失败", caught);
    return NextResponse.json({ error: "来源文件读取失败" }, { status: 500 });
  }
}
