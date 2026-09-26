import ExcelJS from "exceljs";
import { auditStrict as auditStrictDefault, auditTx } from "@/server/audit";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { prisma } from "@/lib/prisma";
import { storage as storageDefault, type StorageProvider } from "@/lib/storage";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { fileSha256, financeTypedRecordFingerprint, rowFingerprint } from "@/lib/finance/source-fingerprint";
import { parseFinanceSource } from "@/lib/finance/finance-source-parser";
import { inspectFinanceHeader, financeHeadersDigest } from "@/lib/finance/import-mapping";
import { parseFinancePdfTables } from "@/lib/finance/pdf-table-parser";
import { readFinanceWorkbookSheets } from "@/lib/finance/import-parser";
import { preprocessFinanceUpload, type FinancePreprocessInput, type FinancePreprocessedUpload } from "@/server/finance/finance-preprocessor-client";
import type {
  CommitFinanceImportInput,
  FinanceColumnMapping,
  FinanceColumnMappingsBySheet,
  FinanceImportPreview,
  FinanceNormalizedRow,
  FinancePayrollImportRow,
  FinanceRosterImportRow,
  FinanceExternalStatementImportRow,
  FinanceSourceKind
} from "@/lib/finance/internal-types";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  commitFinanceImportSchema,
  financeColumnMappingSchema,
  financeColumnMappingsBySheetSchema,
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
  preprocess?: (input: FinancePreprocessInput) => Promise<FinancePreprocessedUpload>;
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
  const extension = extensionOf(fileName);
  if (extension === "csv") return "text/csv";
  if (extension === "pdf") return "application/pdf";
  if (extension === "xls") return "application/vnd.ms-excel";
  if (extension === "xlsm") return "application/vnd.ms-excel.sheet.macroEnabled.12";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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

function parseColumnMappingsBySheet(formData: FormData): FinanceColumnMappingsBySheet | undefined {
  const value = formData.get("columnMappingsBySheet");
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ActionError("列映射格式不正确");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActionError("列映射格式不正确");
  }
  const result = financeColumnMappingsBySheetSchema.safeParse(parsed);
  if (!result.success) throw new ActionError("列映射格式不正确");
  return result.data;
}

function parseKind(formData: FormData): FinanceSourceKind {
  const raw = formData.get("kind") ?? "BANK_STATEMENT";
  const result = financeImportKindSchema.safeParse(String(raw));
  if (!result.success) throw new ActionError("财务资料类型不正确");
  return result.data;
}

async function readUpload(formData: FormData): Promise<{ fileName: string; bytes: Buffer; kind: FinanceSourceKind; mapping?: FinanceColumnMapping; columnMappingsBySheet?: FinanceColumnMappingsBySheet; period?: string; asOfDay?: string }> {
  const candidate = formData.get("file") ?? formData.get("sourceFile");
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    throw new ActionError("缺少财务资料文件");
  }
  const file = candidate as { name?: unknown; arrayBuffer: () => Promise<ArrayBuffer> };
  const fileName = safeFileName(typeof file.name === "string" ? file.name : "finance-import");
  const extension = extensionOf(fileName);
  if (extension !== "csv" && extension !== "xlsx" && extension !== "xlsm" && extension !== "xls" && extension !== "pdf") {
    throw new ActionError("仅支持 CSV、XLSX、XLSM、XLS 或 PDF 文件");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FINANCE_IMPORT_BYTES) {
    throw new ActionError("财务资料不能超过 25 MB");
  }
  const rawPeriod = formData.get("period");
  const periodResult = rawPeriod === null || rawPeriod === "" ? undefined : financePeriodSchema.safeParse(String(rawPeriod));
  if (periodResult && !periodResult.success) throw new ActionError("账期格式应为 YYYY-MM");
  const rawAsOfDay = formData.get("asOfDay");
  const asOfDay = rawAsOfDay === null || rawAsOfDay === "" ? undefined : String(rawAsOfDay);
  if (asOfDay && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) throw new ActionError("花名册截至日期格式不正确");
  return { fileName, bytes, kind: parseKind(formData), mapping: parseMapping(formData), columnMappingsBySheet: parseColumnMappingsBySheet(formData), period: periodResult?.success ? periodResult.data : undefined, asOfDay };
}

type FinanceUploadForParsing = {
  fileName: string;
  bytes: Buffer;
  kind: FinanceSourceKind;
  mapping?: FinanceColumnMapping;
  columnMappingsBySheet?: FinanceColumnMappingsBySheet;
  period?: string;
  asOfDay?: string;
};

type PreparedFinanceSource = {
  parseBytes: Buffer;
  parseFileName: string;
  pdfCandidates: FinanceImportPreview["pdfCandidates"];
  canCommitStructuredRows: boolean;
};

async function pdfTablesToWorkbook(document: Extract<FinancePreprocessedUpload, { kind: "PDF" }>): Promise<PreparedFinanceSource> {
  const parsed = parseFinancePdfTables(document.document);
  const workbook = new ExcelJS.Workbook();
  for (const table of parsed.sheets) {
    const sheet = workbook.addWorksheet(table.name);
    for (const row of table.rows) sheet.addRow(row);
  }
  return {
    parseBytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    parseFileName: "finance-preprocessed.pdf.xlsx",
    pdfCandidates: parsed.ocrCandidates.map((candidate) => ({
      pageNumber: candidate.pageNumber,
      extraction: candidate.extraction,
      wordCount: candidate.words.length
    })),
    canCommitStructuredRows: parsed.canCommitStructuredRows
  };
}

async function prepareFinanceSource(
  upload: FinanceUploadForParsing,
  preprocess: FinanceImportDependencies["preprocess"] = preprocessFinanceUpload
): Promise<PreparedFinanceSource> {
  const extension = extensionOf(upload.fileName);
  if (upload.kind === "OTHER" && (extension === "xls" || extension === "pdf")) {
    return { parseBytes: upload.bytes, parseFileName: upload.fileName, pdfCandidates: [], canCommitStructuredRows: true };
  }
  if (extension !== "xls" && extension !== "pdf") {
    return { parseBytes: upload.bytes, parseFileName: upload.fileName, pdfCandidates: [], canCommitStructuredRows: true };
  }
  const processed = await preprocess({ fileName: upload.fileName, kind: upload.kind, bytes: upload.bytes });
  return processed.kind === "XLSX" ? {
    parseBytes: processed.bytes,
    parseFileName: processed.fileName,
    pdfCandidates: [],
    canCommitStructuredRows: true
  } : pdfTablesToWorkbook(processed);
}

function parseUnstructuredOtherSource(upload: FinanceUploadForParsing) {
  return {
    fileName: upload.fileName,
    kind: "OTHER" as const,
    headers: [],
    rows: [],
    errors: [],
    totalRows: 0,
    period: upload.period,
    asOfDay: undefined,
    reviewWarnings: ["该资料只保存原始文件，不提取为财务事实。"]
  };
}

async function parseFinanceUpload(upload: FinanceUploadForParsing, dependencies: FinanceImportDependencies) {
  const extension = extensionOf(upload.fileName);
  if (upload.kind === "OTHER") {
    const rawOnly = () => ({
      parsed: parseUnstructuredOtherSource(upload),
      prepared: {
        parseBytes: upload.bytes,
        parseFileName: upload.fileName,
        pdfCandidates: [],
        canCommitStructuredRows: true
      }
    });
    if (extension === "xls" || extension === "pdf") return rawOnly();

    try {
      const prepared = await prepareFinanceSource(upload, dependencies.preprocess);
      const parsed = await parseFinanceSource(prepared.parseBytes, prepared.parseFileName, upload.kind, upload);
      if (parsed.errors.length === 0) return { parsed, prepared };
    } catch {
      // OTHER files are retained as originals; best-effort sheet parsing must not block archival.
    }
    return rawOnly();
  }

  const prepared = await prepareFinanceSource(upload, dependencies.preprocess);
  const parsed = await parseFinanceSource(prepared.parseBytes, prepared.parseFileName, upload.kind, upload);
  return { parsed, prepared };
}

async function financeSheetPreviews(
  bytes: Buffer,
  fileName: string,
  kind: FinanceSourceKind,
  explicitMappings: FinanceColumnMappingsBySheet | undefined
): Promise<NonNullable<FinanceImportPreview["sheets"]>> {
  if (kind === "OTHER") return [];
  const workbook = await readFinanceWorkbookSheets(bytes, fileName);
  if (workbook.errors.length) return [];
  return workbook.sheets.flatMap((sheet) => {
    const inspected = inspectFinanceHeader(kind, sheet.matrix);
    if (!inspected) return [];
    const mapping = { ...inspected.mapping, ...(explicitMappings?.[sheet.name] ?? {}) };
    const missingFields = inspected.missingFields.filter((field) => mapping[field] === undefined);
    if (kind === "BANK_STATEMENT" && (mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined)) {
      return [{ sourceSheet: sheet.name, headers: inspected.headers, headerRowNumber: inspected.headerRowNumber, headersDigest: financeHeadersDigest(kind, inspected.headers), mapping, missingFields: missingFields.filter((field) => field !== "amount") }];
    }
    return [{ sourceSheet: sheet.name, headers: inspected.headers, headerRowNumber: inspected.headerRowNumber, headersDigest: financeHeadersDigest(kind, inspected.headers), mapping, missingFields }];
  });
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
        counterparty: bankRow.counterparty ? maskedName(bankRow.counterparty) : null,
        description: bankRow.description ? "已隐藏摘要" : null
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
  dependencies: FinanceImportDependencies = {}
): Promise<FinanceImportPreview> {
  const upload = await readUpload(formData);
  const { parsed: result, prepared } = await parseFinanceUpload(upload, dependencies);
  const sheets = await financeSheetPreviews(prepared.parseBytes, prepared.parseFileName, upload.kind, upload.columnMappingsBySheet);
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
    asOfDay: result.asOfDay,
    sheets,
    pdfCandidates: prepared.pdfCandidates,
    canCommitStructuredRows: prepared.canCommitStructuredRows
  };
}

function dataForSourceRow(row: FinanceNormalizedRow, batchId: string, sourceFileId: string): Prisma.FinanceSourceRowCreateManyInput {
  return {
    batchId,
    sourceFileId,
    sourceSheet: row.sourceSheet ?? "",
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

function dataForTypedRecord(
  row: FinancePayrollImportRow | FinanceRosterImportRow | FinanceExternalStatementImportRow,
  kind: "PAYROLL" | "ROSTER" | "EXTERNAL_THREE_STATEMENTS",
  batchId: string
): Prisma.FinanceImportRecordCreateManyInput {
  if (kind === "PAYROLL") {
    const payroll = row as FinancePayrollImportRow;
    const displayName = truncate(payroll.displayName, 120);
    return {
      batchId,
      sourceSheet: payroll.sourceSheet ?? "",
      sourceRow: payroll.sourceRowNumber,
      kind,
      displayName,
      period: payroll.period,
      declaredSalary: payroll.declaredSalary,
      actualCashPaid: payroll.actualCashPaid,
      selfCostDue: payroll.selfCostDue,
      normalizedDigest: financeTypedRecordFingerprint(kind, {
        displayName,
        period: payroll.period,
        declaredSalary: payroll.declaredSalary,
        actualCashPaid: payroll.actualCashPaid,
        selfCostDue: payroll.selfCostDue
      }),
      reviewStatus: "NEEDS_REVIEW"
    };
  }
  if (kind === "ROSTER") {
    const roster = row as FinanceRosterImportRow;
    const displayName = truncate(roster.displayName, 120);
    const roleLabel = truncate(roster.roleLabel, 100);
    return {
      batchId,
      sourceSheet: roster.sourceSheet ?? "",
      sourceRow: roster.sourceRowNumber,
      kind,
      displayName,
      period: roster.asOfDay.slice(0, 7),
      asOfDay: dayStartInShanghai(roster.asOfDay),
      roleLabel,
      normalizedDigest: financeTypedRecordFingerprint(kind, { displayName, asOfDay: roster.asOfDay, roleLabel }),
      reviewStatus: "NEEDS_REVIEW"
    };
  }
  const statement = row as FinanceExternalStatementImportRow;
  const item = truncate(statement.item, 200);
  return {
    batchId,
    sourceSheet: statement.sourceSheet ?? "",
    sourceRow: statement.sourceRowNumber,
    kind,
    period: statement.period,
    statement: statement.statement,
    item,
    amount: statement.amount,
    normalizedDigest: financeTypedRecordFingerprint(kind, { period: statement.period, statement: statement.statement, item, amount: statement.amount }),
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

function fingerprintFromMetadata(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fingerprint = (value as Prisma.JsonObject).rowFingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

async function assertNoDuplicateStructuredRows(
  db: Pick<PrismaClient, "financeSourceRow" | "financeImportRecord"> | Prisma.TransactionClient,
  parsed: Awaited<ReturnType<typeof parseFinanceUpload>>["parsed"],
  period: string
): Promise<void> {
  if (parsed.kind === "BANK_STATEMENT") {
    const bounds = periodBounds(period);
    const existing = await db.financeSourceRow.findMany({
      where: {
        occurredAt: { gte: bounds.start, lt: bounds.end },
        batch: { kind: "BANK_STATEMENT", status: "COMMITTED" }
      },
      select: { metadata: true }
    });
    const existingFingerprints = new Set(existing.map((row) => fingerprintFromMetadata(row.metadata)));
    const incomingFingerprints = parsed.rows.map(rowFingerprint);
    if (
      new Set(incomingFingerprints).size !== incomingFingerprints.length ||
      incomingFingerprints.some((fingerprint) => existingFingerprints.has(fingerprint))
    ) {
      throw new ActionError("该文件包含已导入的重复流水行，请先核对来源后再导入");
    }
    return;
  }

  if (parsed.kind === "PAYROLL" || parsed.kind === "ROSTER" || parsed.kind === "EXTERNAL_THREE_STATEMENTS") {
    const normalizedRows = parsed.rows.map((row) => dataForTypedRecord(row, parsed.kind, "pending"));
    const candidates = normalizedRows.map((row) => row.normalizedDigest);
    const periods = [...new Set(normalizedRows.map((row) => row.period ?? period))];
    const existing = await db.financeImportRecord.findMany({
      where: { kind: parsed.kind, period: { in: periods }, normalizedDigest: { in: candidates } },
      select: { normalizedDigest: true }
    });
    const existingDigests = new Set(existing.map((row) => row.normalizedDigest));
    if (
      new Set(candidates).size !== candidates.length ||
      candidates.some((digest) => existingDigests.has(digest))
    ) {
      throw new ActionError("该文件包含已导入的重复财务记录，请先核对来源后再导入");
    }
  }
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
  const { parsed, prepared } = await parseFinanceUpload({ ...data, fileName }, dependencies);
  if (!prepared.canCommitStructuredRows) throw new ActionError("PDF 页面未能形成稳定表格；请人工整理后再导入");
  if (parsed.totalRows === 0 && parsed.kind !== "OTHER") throw new ActionError("文件中没有可提交的数据行");
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

  let period: string | undefined;
  if (parsed.kind === "BANK_STATEMENT") {
    const occurredDays = parsed.rows.map((row) => row.occurredAt).sort();
    if (!occurredDays.length) throw new ActionError("文件中没有可提交的银行流水");
    period = occurredDays[0].slice(0, 7);
    if (occurredDays.some((day) => day.slice(0, 7) !== period)) throw new ActionError("银行流水文件包含多个账期，请按月拆分后导入");
  } else {
    period = parsed.period ?? data.period ?? (parsed.kind === "ROSTER" ? parsed.asOfDay?.slice(0, 7) : undefined);
  }
  if (!period && parsed.kind !== "OTHER") throw new ActionError("无法确定资料账期，请选择或填写 YYYY-MM");
  const { start: periodStart, end: periodEnd } = period ? periodBounds(period) : { start: null, end: null };

  if (parsed.kind !== "OTHER") await assertNoDuplicateStructuredRows(db, parsed, period!);
  const actorId = dependencies.actorId ?? (await requireSession("finance.import")).user.id;
  const storageProvider = dependencies.storage ?? storageDefault;
  const storagePath = await storageProvider.writeFile("finance-imports", data.bytes);

  try {
    const committed = await db.$transaction(async (tx) => {
      if (parsed.kind !== "OTHER") await assertNoDuplicateStructuredRows(tx, parsed, period!);
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { batchId: committed.id, duplicate: false };
  } catch (caught) {
    try {
      await storageProvider.deleteFile(storagePath);
    } catch {
      console.error("[finance-import] 事务失败后清理来源文件失败（详细信息已省略）");
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

  const strictAudit = dependencies.auditStrict ?? auditStrictDefault;
  await strictAudit({
    userId: viewer.id,
    action: "FINANCE_INTERNAL_IMPORT_SOURCE_DOWNLOAD_ATTEMPT",
    targetType: "FinanceImportBatch",
    targetId: batch.id,
    detail: {
      kind: batch.kind,
      fileExtension: extensionOf(batch.sourceFile.fileName)
    }
  });

  const storageProvider = dependencies.storage ?? storageDefault;
  const bytes = await storageProvider.readFile(batch.sourceFile.storagePath);
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

const SOURCE_PREVIEW_PAGE_SIZE = 100;

export type FinanceImportSourcePreview = {
  fileName: string;
  kind: string;
  extension: string;
  available: boolean;
  unavailableReason: string | null;
  sheetCount: number;
  selectedSheet: {
    index: number;
    name: string;
    totalRows: number;
    page: number;
    pageSize: number;
    totalPages: number;
    rows: Array<{ sourceRow: number; cells: string[] }>;
  } | null;
  ocrCandidatePages: number[];
};

type FinanceSourcePreviewOptions = { sheetIndex?: number; page?: number };

export async function previewFinanceImportSource(
  id: string,
  viewer: FinanceImportViewer,
  options: FinanceSourcePreviewOptions = {},
  dependencies: FinanceImportDependencies = {}
): Promise<FinanceImportSourcePreview> {
  const parsedId = sourceDownloadSchema.safeParse({ id });
  if (!parsedId.success) throw new FinanceImportNotFoundError();
  const db = dependencies.db ?? prisma;
  const batch = await db.financeImportBatch.findUnique({
    where: { id: parsedId.data.id },
    include: { sourceFile: true }
  });
  if (!batch || batch.status !== "COMMITTED" || !batch.sourceFile) throw new FinanceImportNotFoundError();
  if (!canReadFinanceImport(viewer, batch)) throw new FinanceImportForbiddenError();

  const fileName = batch.sourceFile.fileName;
  const extension = extensionOf(fileName);
  const base = {
    fileName,
    kind: String(batch.kind),
    extension,
    ocrCandidatePages: [] as number[]
  };
  const requestedSheet = Number.isInteger(options.sheetIndex) && (options.sheetIndex ?? -1) >= 0
    ? Math.min(options.sheetIndex as number, 1000)
    : 0;
  const requestedPage = Number.isInteger(options.page) && (options.page ?? 0) > 0
    ? Math.min(options.page as number, 10000)
    : 1;
  const strictAudit = dependencies.auditStrict ?? auditStrictDefault;
  await strictAudit({
    userId: viewer.id,
    action: "FINANCE_INTERNAL_IMPORT_SOURCE_PREVIEW",
    targetType: "FinanceImportBatch",
    targetId: batch.id,
    detail: {
      kind: batch.kind,
      fileExtension: extension,
      sheetIndex: requestedSheet,
      page: requestedPage
    }
  });

  const unavailable = (unavailableReason: string): FinanceImportSourcePreview => ({
    ...base,
    available: false,
    unavailableReason,
    sheetCount: 0,
    selectedSheet: null
  });

  if (!(extension === "csv" || extension === "xlsx" || extension === "xlsm" || extension === "xls" || extension === "pdf")) {
    return unavailable("此文件类型暂不支持在线表格预览，请下载原件查看。");
  }

  const storageProvider = dependencies.storage ?? storageDefault;
  const bytes = await storageProvider.readFile(batch.sourceFile.storagePath);
  let sheets: Array<{ name: string; matrix: string[][] }> = [];
  let ocrCandidatePages: number[] = [];
  if (extension === "xls" || extension === "pdf") {
    const preprocess = dependencies.preprocess ?? preprocessFinanceUpload;
    const processed = await preprocess({ fileName, kind: "OTHER", bytes });
    if (processed.kind === "XLSX") {
      const workbook = await readFinanceWorkbookSheets(processed.bytes, processed.fileName);
      if (workbook.errors.length > 0) return unavailable("来源表格无法读取，请下载原件人工核对。");
      sheets = workbook.sheets;
    } else {
      const parsed = parseFinancePdfTables(processed.document);
      sheets = parsed.sheets.map((sheet) => ({ name: sheet.name, matrix: sheet.rows }));
      ocrCandidatePages = parsed.ocrCandidates.map((candidate) => candidate.pageNumber);
    }
  } else {
    const workbook = await readFinanceWorkbookSheets(bytes, fileName);
    if (workbook.errors.length > 0) return unavailable("来源表格无法读取，请下载原件人工核对。");
    sheets = workbook.sheets;
  }

  if (sheets.length === 0) return unavailable("文件中没有可在线预览的表格；请下载原件查看。");

  const sheetIndex = Math.min(requestedSheet, sheets.length - 1);
  const sheet = sheets[sheetIndex];
  const totalRows = sheet.matrix.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / SOURCE_PREVIEW_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * SOURCE_PREVIEW_PAGE_SIZE;
  const rows = sheet.matrix.slice(start, start + SOURCE_PREVIEW_PAGE_SIZE).map((cells, index) => ({
    sourceRow: start + index + 1,
    cells
  }));

  return {
    ...base,
    available: true,
    unavailableReason: null,
    sheetCount: sheets.length,
    selectedSheet: {
      index: sheetIndex,
      name: sheet.name,
      totalRows,
      page,
      pageSize: SOURCE_PREVIEW_PAGE_SIZE,
      totalPages,
      rows
    },
    ocrCandidatePages
  };
}
