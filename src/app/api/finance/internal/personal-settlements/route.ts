import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { ActionError } from "@/lib/action-error";
import { buildLawyerSettlementWorkbook, buildLawyerSettlementZip } from "@/server/finance/personal-settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(caught: unknown) {
  if (caught instanceof ActionError) {
    const status = caught.message.includes("权限") || caught.message.includes("无权") ? 403 : 400;
    return NextResponse.json({ error: caught.message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
  console.error("[finance-personal-settlement/export] 失败（详细信息已省略）");
  return NextResponse.json({ error: "律师结算文件导出失败" }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId")?.trim();
  if (!runId || runId.length > 100) return NextResponse.json({ error: "正式批次参数不正确" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });

  try {
    const zipMode = url.searchParams.get("format") === "zip";
    const bytes = zipMode
      ? await buildLawyerSettlementZip(runId, session.user)
      : await buildLawyerSettlementWorkbook(runId, session.user.id, session.user);
    const period = url.searchParams.get("period")?.match(/^\d{4}-(0[1-9]|1[0-2])$/)?.[0] ?? "结算";
    const fileName = zipMode ? `律师结算-${period}.zip` : `个人结算-${period}.xlsx`;
    const contentType = zipMode ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      }
    });
  } catch (caught) {
    return errorResponse(caught);
  }
}
