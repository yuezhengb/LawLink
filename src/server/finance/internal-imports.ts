import { auditStrict as auditStrictDefault, auditTx } from "@/server/audit";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { storage as storageDefault, type StorageProvider } from "@/lib/storage";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { fileSha256, rowFingerprint } from "@/lib/finance/source-fingerprint";
import { parseFinanceWorkbook } from "@/lib/finance/import-parser";
import type {
  CommitFinanceImportInput,
  FinanceColumnMapping,
  FinanceImportPreview,
  FinanceNormalizedRow,
  FinanceSourceKind
} from "@/lib/finance/internal-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  commitFinanceImportSchema,
  financeColumnMappingSchema,
  financeImportKindSchema,
  MAX_FINANCE_IMPORT_BYTES,
  sourceDownloadSchema
} from "@/server/finance/internal-schemas";

export type FinanceImportViewer = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[] | null;
};

export type FinanceImportDependencies = {
  db?: PrismaClient;
  storage?: StorageProvider;
  actorId?: string;
  auditStrict?: typeof auditStrictDefault;
};

export class FinanceImportNotFoundError extends Error {
  constructor() {
    super("来源文件不存在");
    this.name = "FinanceImportNotFoundError";
  }
}

export class FinanceImportForbiddenError extends Error {
  constructor() {
    super("无权访问该来源文件");
    this.name = "FinanceImportForbiddenError";
  }
}

function extensionOf(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function mimeTypeOf(fileName: string): string {
  return extensionOf(fileName) === "csv"
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function safeFileName(fileName: string): string {
  const normalized = fileName
    .replace(/[\u0000-\u001F<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return normalized || "finance-import";
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function dayStartInShanghai(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

function parseMapping(formData: FormData): FinanceColumnMapping | undefined {
  const value = formData.get("mapping");
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ActionError("列映射格式不正确");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActionError("列映射格式不正确");
  }
  const result = financeColumnMappingSchema.safeParse(parsed);
  if (!result.success) throw new ActionError("列映射格式不正确");
  return result.data;
}

function parseKind(formData: FormData): FinanceSourceKind {
  const raw = formData.get("kind") ?? "BANK_STATEMENT";
  const result = financeImportKindSchema.safeParse(String(raw));
  if (!result.success) throw new ActionError("财务资料类型不正确");
  return result.data;
}

async function readUpload(formData: FormData): Promise<{ fileName: string; bytes: Buffer; kind: FinanceSourceKind; mapping?: FinanceColumnMapping }> {
  const candidate = formData.get("file") ?? formData.get("sourceFile");
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    throw new ActionError("缺少财务资料文件");
  }
  const file = candidate as { name?: unknown; arrayBuffer: () => Promise<ArrayBuffer> };
  const fileName = safeFileName(typeof file.name === "string" ? file.name : "finance-import");
  const extension = extensionOf(fileName);
  if (extension !== "csv" && extension !== "xlsx" && extension !== "xls") {
    throw new ActionError("仅支持 CSV 或 XLSX 文件；传统 XLS 请先转换为 XLSX");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > MAX_FINANCE_IMPORT_BYTES) {
    throw new ActionError("财务资料不能超过 25 MB");
  }
  return { fileName, bytes, kind: parseKind(formData), mapping: parseMapping(formData) };
}

function safePreviewRows(rows: FinanceNormalizedRow[]): FinanceNormalizedRow[] {
  return rows.map((row) => ({
    ...row,
    sourceBatchId: undefined,
    sourceFileId: undefined,
    counterparty: truncate(row.counterparty, 160),
    description: truncate(row.description, 300)
  }));
}

export async function previewFinanceImport(
  formData: FormData,
  _dependencies: FinanceImportDependencies = {}
): Promise<FinanceImportPreview> {
  void _dependencies;
  const upload = await readUpload(formData);
  const result = await parseFinanceWorkbook(upload.bytes, upload.fileName, upload.kind, upload.mapping);
  return {
    fileName: upload.fileName,
    kind: upload.kind,
    headers: result.headers,
    rows: safePreviewRows(result.rows),
    errors: result.errors,
    validCount: result.rows.length,
    totalRows: result.totalRows
  };
}

function dataForSourceRow(row: FinanceNormalizedRow, batchId: string, sourceFileId: string): Prisma.FinanceSourceRowCreateManyInput {
  return {
    batchId,
    sourceFileId,
    sourceRow: row.sourceRowNumber,
    occurredAt: dayStartInShanghai(row.occurredAt),
    amount: row.amount,
    direction: row.direction,
    balance: row.balance ?? null,
    counterpartyDigest: row.counterpartyDigest ?? null,
    counterpartyDisplay: truncate(row.counterparty, 160),
    accountMasked: row.accountMasked ?? null,
    descriptionDigest: row.descriptionDigest ?? null,
    descriptionDisplay: truncate(row.description, 300),
    externalReference: row.externalReference ?? null,
    invoiceReference: row.invoiceReference ?? null,
    metadata: { sourceKind: row.sourceKind, rowFingerprint: rowFingerprint(row) }
  };
}

export async function commitFinanceImport(
  input: CommitFinanceImportInput,
  dependencies: FinanceImportDependencies = {}
): Promise<{ batchId: string; duplicate: boolean }> {
  const parsedInput = commitFinanceImportSchema.safeParse(input);
  if (!parsedInput.success) throw new ActionError("财务资料提交内容不正确");
  const data = parsedInput.data;
  if (data.bytes.byteLength > MAX_FINANCE_IMPORT_BYTES) throw new ActionError("财务资料不能超过 25 MB");

  const fileName = safeFileName(data.fileName);
  const parsed = await parseFinanceWorkbook(data.bytes, fileName, data.kind, data.mapping);
  if (parsed.totalRows === 0) throw new ActionError("文件中没有可提交的数据行");
  if (parsed.errors.length > 0) {
    throw new ActionError(`导入未提交：有 ${parsed.errors.length} 行需要先修正`);
  }

  const sourceHash = fileSha256(data.bytes);
  const db = dependencies.db ?? prisma;
  const existing = await db.financeImportBatch.findUnique({
    where: { sourceHash_kind: { sourceHash, kind: data.kind } },
    select: { id: true, status: true }
  });
  if (existing?.status === "COMMITTED") return { batchId: existing.id, duplicate: true };
  if (existing) throw new ActionError("该文件已有未完成的导入批次，请先处理原批次");

  const actorId = dependencies.actorId ?? (await requireSession("finance.import")).user.id;
  const storageProvider = dependencies.storage ?? storageDefault;
  const storagePath = await storageProvider.writeFile("finance-imports", data.bytes);
  const occurredDays = parsed.rows.map((row) => row.occurredAt).sort();
  const periodStart = dayStartInShanghai(occurredDays[0]);
  const periodEnd = dayStartInShanghai(occurredDays[occurredDays.length - 1]);

  try {
    const committed = await db.$transaction(async (tx) => {
      const batch = await tx.financeImportBatch.create({
        data: {
          sourceHash,
          kind: data.kind,
          fileName,
          status: "COMMITTED",
          periodStart,
          periodEnd,
          rowCount: parsed.rows.length,
          errorCount: 0,
          createdById: actorId
        },
        select: { id: true }
      });
      const sourceFile = await tx.financeSourceFile.create({
        data: {
          batchId: batch.id,
          fileName,
          storagePath,
          mimeType: mimeTypeOf(fileName),
          byteSize: data.bytes.byteLength,
          sha256: sourceHash
        },
        select: { id: true }
      });
      await tx.financeSourceRow.createMany({
        data: parsed.rows.map((row) => dataForSourceRow(row, batch.id, sourceFile.id))
      });
      const sourceRows = await tx.financeSourceRow.findMany({
        where: { batchId: batch.id },
        select: { id: true }
      });
      await tx.financeReconciliationCase.createMany({
        data: sourceRows.map((sourceRow) => ({
          batchId: batch.id,
          sourceRowId: sourceRow.id,
          status: "UNRESOLVED",
          suggestions: []
        }))
      });
      await auditTx(tx, {
        userId: actorId,
        action: "FINANCE_INTERNAL_IMPORT_COMMIT",
        targetType: "FinanceImportBatch",
        targetId: batch.id,
        detail: {
          kind: data.kind,
          fileExtension: extensionOf(fileName),
          byteCount: data.bytes.byteLength,
          rowCount: parsed.rows.length
        }
      });
      return batch;
    });
    return { batchId: committed.id, duplicate: false };
  } catch (caught) {
    try {
      await storageProvider.deleteFile(storagePath);
    } catch (cleanupError) {
      console.error("[finance-import] 事务失败后清理来源文件失败", cleanupError);
    }
    throw caught;
  }
}

export function canManageFinanceImports(user: FinanceImportViewer): boolean {
  if (user.role === "FINANCE") return true;
  return user.role === "CUSTOM" && scopeFor({ role: user.role, rolePermissions: user.rolePermissions ?? undefined }, "finance.import") === "ALL";
}

export function canReadFinanceImport(user: FinanceImportViewer, batch: { createdById: string }): boolean {
  if (user.role === "FINANCE") return true;
  if (user.role !== "CUSTOM") return false;
  const grantsUser = { role: user.role, rolePermissions: user.rolePermissions ?? undefined };
  if (scopeFor(grantsUser, "finance.import") === "ALL" || scopeFor(grantsUser, "finance.read") === "ALL") return true;
  return scopeFor(grantsUser, "finance.read") === "OWN" && batch.createdById === user.id;
}

export async function downloadFinanceImportSource(
  id: string,
  viewer: FinanceImportViewer,
  dependencies: FinanceImportDependencies = {}
): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  const parsedId = sourceDownloadSchema.safeParse({ id });
  if (!parsedId.success) throw new FinanceImportNotFoundError();
  const db = dependencies.db ?? prisma;
  const batch = await db.financeImportBatch.findUnique({
    where: { id: parsedId.data.id },
    include: { sourceFile: true }
  });
  if (!batch || batch.status !== "COMMITTED" || !batch.sourceFile) throw new FinanceImportNotFoundError();
  if (!canReadFinanceImport(viewer, batch)) throw new FinanceImportForbiddenError();

  const storageProvider = dependencies.storage ?? storageDefault;
  const bytes = await storageProvider.readFile(batch.sourceFile.storagePath);
  const strictAudit = dependencies.auditStrict ?? auditStrictDefault;
  await strictAudit({
    userId: viewer.id,
    action: "FINANCE_INTERNAL_IMPORT_SOURCE_DOWNLOAD",
    targetType: "FinanceImportBatch",
    targetId: batch.id,
    detail: {
      kind: batch.kind,
      byteCount: bytes.byteLength,
      fileExtension: extensionOf(batch.sourceFile.fileName)
    }
  });
  return { bytes, fileName: batch.sourceFile.fileName, mimeType: batch.sourceFile.mimeType };
}
