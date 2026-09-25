import { z } from "zod";
import { ActionError } from "@/lib/action-error";
import { MAX_FINANCE_IMPORT_BYTES } from "@/server/finance/internal-schemas";
import type { FinanceSourceKind } from "@/lib/finance/internal-types";
import type { FinancePdfPreprocessResult } from "@/lib/finance/pdf-table-parser";

const PREPROCESS_TIMEOUT_MS = 120_000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const pdfWordSchema = z.object({
  text: z.string().max(100),
  confidence: z.number().min(0).max(100),
  bbox: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])
}).strict();

const pdfResultSchema = z.object({
  version: z.literal(1),
  pages: z.array(z.object({
    pageNumber: z.number().int().min(1).max(50),
    extraction: z.enum(["TEXT_TABLE", "TEXT_CANDIDATE", "OCR_TABLE", "OCR_CANDIDATE"]),
    tables: z.array(z.array(z.array(z.string().max(4000)).max(100))).max(100),
    ocrWords: z.array(pdfWordSchema).max(2000)
  }).strict()).min(1).max(50)
}).strict().superRefine((value, context) => {
  let cells = 0;
  value.pages.forEach((page, pageIndex) => page.tables.forEach((table, tableIndex) => table.forEach((row, rowIndex) => {
    cells += row.length;
    if (cells > 100_000) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", pageIndex, "tables", tableIndex, rowIndex], message: "表格内容超限" });
  })));
});

export type FinancePreprocessInput = { fileName: string; kind: FinanceSourceKind; bytes: Buffer };
export type FinancePreprocessedUpload =
  | { kind: "XLSX"; fileName: string; bytes: Buffer }
  | { kind: "PDF"; document: FinancePdfPreprocessResult };
export type FinancePreprocessorDependencies = { fetcher?: typeof fetch };

function safeOutputFileName(fileName: string): string {
  const leaf = fileName.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 255);
  return `${leaf.slice(0, -4)}.xlsx`;
}

function endpointFromEnvironment(): { endpoint: string; token: string } {
  const rawUrl = process.env.FINANCE_PREPROCESSOR_URL;
  const token = process.env.FINANCE_PREPROCESSOR_TOKEN;
  if (!rawUrl || !token) throw new ActionError("财务文件预处理服务未配置");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ActionError("财务文件预处理服务未配置");
  }
  if (url.protocol !== "http:" || url.hostname !== "finance-preprocessor" || url.port !== "8080" || url.username || url.password || url.search || url.hash) {
    throw new ActionError("财务文件预处理服务地址无效");
  }
  return { endpoint: new URL("/v1/preprocess", url).toString(), token };
}

export async function preprocessFinanceUpload(
  input: FinancePreprocessInput,
  dependencies: FinancePreprocessorDependencies = {}
): Promise<FinancePreprocessedUpload> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_FINANCE_IMPORT_BYTES) throw new ActionError("财务资料不能超过 25 MB");
  const extension = input.fileName.toLowerCase().split(".").pop();
  if (extension !== "xls" && extension !== "pdf") throw new ActionError("仅对传统 XLS 或 PDF 调用隔离预处理服务");
  const { endpoint, token } = endpointFromEnvironment();
  const fetcher = dependencies.fetcher ?? fetch;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), PREPROCESS_TIMEOUT_MS);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Source-Name-Base64": Buffer.from(input.fileName, "utf8").toString("base64url"),
        "X-Source-Kind": input.kind
      },
      body: input.bytes as unknown as BodyInit,
      redirect: "error",
      signal: abortController.signal
    });
    if (!response.ok) throw new ActionError("来源文件无法安全预处理");
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (extension === "xls") {
      if (contentType !== XLSX_MIME) throw new ActionError("来源文件无法安全预处理");
      const converted = Buffer.from(await response.arrayBuffer());
      if (converted.length < 4 || converted.length > MAX_FINANCE_IMPORT_BYTES || converted[0] !== 0x50 || converted[1] !== 0x4b) {
        throw new ActionError("来源文件无法安全预处理");
      }
      return { kind: "XLSX", fileName: safeOutputFileName(input.fileName), bytes: converted };
    }
    if (contentType !== "application/json") throw new ActionError("来源文件无法安全预处理");
    const parsed = pdfResultSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ActionError("来源文件无法安全预处理");
    return { kind: "PDF", document: parsed.data };
  } catch (caught) {
    if (caught instanceof ActionError) throw caught;
    throw new ActionError("来源文件无法安全预处理");
  } finally {
    clearTimeout(timer);
  }
}
