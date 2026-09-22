import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { FinanceArtifactNotFoundError, downloadFinanceArtifact } from "@/server/finance/monthly-close";
import { ActionError } from "@/lib/action-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const { id } = await params;
    const result = await downloadFinanceArtifact(id, { actor: session.user });
    const arrayBuffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
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
    if (caught instanceof ActionError) return NextResponse.json({ error: caught.message }, { status: 403 });
    if (caught instanceof FinanceArtifactNotFoundError) return NextResponse.json({ error: caught.message }, { status: 404 });
    console.error("[finance-artifacts] 失败", caught);
    return NextResponse.json({ error: "财务交付文件读取失败" }, { status: 500 });
  }
}
