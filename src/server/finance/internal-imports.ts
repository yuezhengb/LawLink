import { createHash } from "node:crypto";
import { auditStrict as auditStrictDefault, auditTx } from "@/server/audit";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { storage as storageDefault, type StorageProvider } from "@/lib/storage";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { fileSha256, rowFingerprint } from "@/lib/finance/source-fingerprint";
import { parseFinanceSource } from "@/lib/finance/finance-source-parser";
import type {
  CommitFinanceImportInput,
  FinanceColumnMapping,
  FinanceImportPreview,
  FinanceNormalizedRow,
  FinancePayrollImportRow,
  FinanceRosterImportRow,
  FinanceExternalStatementImportRow,
  FinanceSourceKind
} from "@/lib/finance/internal-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  commitFinanceImportSchema,
  financeColumnMappingSchema,
  financeImportKindSchema,
  financePeriodSchema,
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

async function readUpload(formData: FormData): Promise<{ fileName: string; bytes: Buffer; kind: FinanceSourceKind; mapping?: FinanceColumnMapping; period?: string; asOfDay?: string }> {
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
  const rawPeriod = formData.get("period");
  const periodResult = rawPeriod === null || rawPeriod === "" ? undefined : financePeriodSchema.safeParse(String(rawPeriod));
  if (periodResult && !periodResult.success) throw new ActionError("账期格式应为 YYYY-MM");
  const rawAsOfDay = formData.get("asOfDay");
  const asOfDay = rawAsOfDay === null || rawAsOfDay === "" ? undefined : String(rawAsOfDay);
  if (asOfDay && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) throw new ActionError("花名册截至日期格式不正确");
  return { fileName, bytes, kind: parseKind(formData), mapping: parseMapping(formData), period: periodResult?.success ? periodResult.data : undefined, asOfDay };
}

function maskedName(value: string): string {
  if (value.length < 2) return "*";
  return `${value.slice(0, 1)}${"*".repeat(Math.min(4, value.length - 1))}`;
}

function safePreviewRows(rows: FinanceImportPreview["rows"]): FinanceImportPreview["rows"] {
  return rows.map((row) => {
    if ("occurredAt" in row) {
      const bankRow = row as FinanceNormalizedRow;
      return {
        ...bankRow,
        sourceBatchId: undefined,
        sourceFileId: undefined,
        counterparty: truncate(bankRow.counterparty, 160),
        description: truncate(bankRow.description, 300)
      };
    }
    if ("displayName" in row) {
      return { ...row, displayName: maskedName(row.displayName) };
    }
    return row;
  });
}

export async function previewFinanceImport(
  formData: FormData,
  _dependencies: FinanceImportDependencies = {}
): Promise<FinanceImportPreview> {
  void _dependencies;
  const upload = await readUpload(formData);
  const result = await parseFinanceSource(upload.bytes, upload.fileName, upload.kind, upload);
  return {
    fileName: upload.fileName,
    kind: upload.kind,
    headers: result.headers,
    rows: safePreviewRows(result.rows),
    errors: result.errors,
    validCount: result.kind === "OTHER" ? result.totalRows : result.rows.length,
    totalRows: result.totalRows,
    reviewWarnings: result.reviewWarnings,
    period: result.period,
    asOfDay: result.asOfDay
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

function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dataForTypedRecord(
  row: FinancePayrollImportRow | FinanceRosterImportRow | FinanceExternalStatementImportRow,
  kind: "PAYROLL" | "ROSTER" | "EXTERNAL_THREE_STATEMENTS",
  batchId: string
): Prisma.FinanceImportRecordCreateManyInput {
  if (kind === "PAYROLL") {
    const payroll = row as FinancePayrollImportRow;
    const normalized = { period: payroll.period, declaredSalary: payroll.declaredSalary, actualCashPaid: payroll.actualCashPaid, selfCostDue: payroll.selfCostDue };
    return {
      batchId,
      sourceRow: payroll.sourceRowNumber,
      kind,
      period: payroll.period,
      declaredSalary: payroll.declaredSalary,
      actualCashPaid: payroll.actualCashPaid,
      selfCostDue: payroll.selfCostDue,
      normalizedDigest: digestValue(normalized),
      reviewStatus: "NEEDS_REVIEW"
    };
  }
  if (kind === "ROSTER") {
    const roster = row as FinanceRosterImportRow;
    const normalized = { asOfDay: roster.asOfDay, roleLabel: roster.roleLabel };
    return {
      batchId,
      sourceRow: roster.sourceRowNumber,
      kind,
      period: roster.asOfDay.slice(0, 7),
      asOfDay: dayStartInShanghai(roster.asOfDay),
      roleLabel: truncate(roster.roleLabel, 100),
      normalizedDigest: digestValue(normalized),
      reviewStatus: "NEEDS_REVIEW"
    };
  }
  const statement = row as FinanceExternalStatementImportRow;
  const normalized = { period: statement.period, statement: statement.statement, item: statement.item, amount: statement.amount };
  return {
    batchId,
    sourceRow: statement.sourceRowNumber,
    kind,
    period: statement.period,
    statement: statement.statement,
    item: truncate(statement.item, 200),
    amount: statement.amount,
    normalizedDigest: digestValue(normalized),
    reviewStatus: "NEEDS_REVIEW"
  };
}

function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: dayStartInShanghai(`${period}-01`),
    end: dayStartInShanghai(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`)
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
  const parsed = await parseFinanceSource(data.bytes, fileName, data.kind, data);
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
  let period: string | undefined;
  if (parsed.kind === "BANK_STATEMENT") {
    const occurredDays = parsed.rows.map((row) => row.occurredAt).sort();
    if (!occurredDays.length) throw new ActionError("文件中没有可提交的银行流水");
    period = occurredDays[0].slice(0, 7);
    if (occurredDays.some((day) => day.slice(0, 7) !== period)) throw new ActionError("银行流水文件包含多个账期，请按月拆分后导入");
  } else {
    period = parsed.period ?? data.period ?? (parsed.kind === "ROSTER" ? parsed.asOfDay?.slice(0, 7) : undefined);
  }
  if (!period) throw new ActionError("无法确定资料账期，请选择或填写 YYYY-MM");
  const { start: periodStart, end: periodEnd } = periodBounds(period);

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
          rowCount: parsed.kind === "OTHER" ? parsed.totalRows : parsed.rows.length,
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
      if (parsed.kind === "BANK_STATEMENT") {
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
      } else if (parsed.kind === "PAYROLL" || parsed.kind === "ROSTER" || parsed.kind === "EXTERNAL_THREE_STATEMENTS") {
        await tx.financeImportRecord.createMany({
          data: parsed.rows.map((row) => dataForTypedRecord(row, parsed.kind, batch.id))
        });
      }
      await auditTx(tx, {
        userId: actorId,
        action: "FINANCE_INTERNAL_IMPORT_COMMIT",
        targetType: "FinanceImportBatch",
        targetId: batch.id,
        detail: {
          kind: data.kind,
          fileExtension: extensionOf(fileName),
          byteCount: data.bytes.byteLength,
          rowCount: parsed.kind === "OTHER" ? parsed.totalRows : parsed.rows.length
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
