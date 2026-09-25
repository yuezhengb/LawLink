import { ActionError } from "@/lib/action-error";
import type { FinanceSourceKind, FinanceImportIndexMapping } from "@/lib/finance/internal-types";
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";
import { canManageFinanceImports, type FinanceImportViewer } from "@/server/finance/internal-imports";
import { financeImportKindSchema, financeMappingTemplateInputSchema } from "@/server/finance/internal-schemas";
import type { Prisma, PrismaClient } from "@prisma/client";

export type FinanceMappingTemplateDependencies = { db?: PrismaClient };

export type FinanceMappingTemplateView = {
  id: string;
  kind: FinanceSourceKind;
  headersDigest: string;
  mapping: FinanceImportIndexMapping;
  updatedAt: string;
};

function assertCanManage(viewer: FinanceImportViewer): void {
  if (!canManageFinanceImports(viewer)) throw new ActionError("无财务资料导入权限");
}

function toView(record: {
  id: string;
  kind: FinanceSourceKind;
  headersDigest: string;
  mapping: Prisma.JsonValue;
  updatedAt: Date;
}): FinanceMappingTemplateView {
  const mapping = financeMappingTemplateInputSchema.shape.mapping.safeParse(record.mapping);
  if (!mapping.success) throw new ActionError("已保存的映射模板无效，请重新建立");
  return {
    id: record.id,
    kind: record.kind,
    headersDigest: record.headersDigest,
    mapping: mapping.data as FinanceImportIndexMapping,
    updatedAt: record.updatedAt.toISOString()
  };
}

export async function listFinanceImportMappingTemplates(
  rawKind: unknown,
  viewer: FinanceImportViewer,
  dependencies: FinanceMappingTemplateDependencies = {}
): Promise<FinanceMappingTemplateView[]> {
  assertCanManage(viewer);
  const parsedKind = financeImportKindSchema.safeParse(rawKind);
  if (!parsedKind.success) throw new ActionError("资料类型不正确");
  const db = dependencies.db ?? prisma;
  const records = await db.financeImportMappingTemplate.findMany({
    where: { kind: parsedKind.data },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, kind: true, headersDigest: true, mapping: true, updatedAt: true }
  });
  return records.map(toView);
}

export async function saveFinanceImportMappingTemplate(
  input: unknown,
  viewer: FinanceImportViewer,
  dependencies: FinanceMappingTemplateDependencies = {}
): Promise<FinanceMappingTemplateView> {
  assertCanManage(viewer);
  const parsed = financeMappingTemplateInputSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("映射模板内容不正确");
  const db = dependencies.db ?? prisma;
  const mapping = parsed.data.mapping as Prisma.InputJsonValue;
  return db.$transaction(async (tx) => {
    const record = await tx.financeImportMappingTemplate.upsert({
      where: { kind_headersDigest: { kind: parsed.data.kind, headersDigest: parsed.data.headersDigest } },
      create: {
        kind: parsed.data.kind,
        headersDigest: parsed.data.headersDigest,
        mapping,
        createdById: viewer.id
      },
      update: { mapping, createdById: viewer.id },
      select: { id: true, kind: true, headersDigest: true, mapping: true, updatedAt: true }
    });
    await auditTx(tx, {
      userId: viewer.id,
      action: "FINANCE_IMPORT_MAPPING_TEMPLATE_SAVE",
      targetType: "FinanceImportMappingTemplate",
      targetId: record.id,
      detail: { kind: parsed.data.kind, headersDigest: parsed.data.headersDigest, mappedFieldCount: Object.keys(parsed.data.mapping).length }
    });
    return toView(record);
  });
}

export async function deleteFinanceImportMappingTemplate(
  id: unknown,
  viewer: FinanceImportViewer,
  dependencies: FinanceMappingTemplateDependencies = {}
): Promise<void> {
  assertCanManage(viewer);
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ActionError("映射模板不存在");
  const db = dependencies.db ?? prisma;
  await db.$transaction(async (tx) => {
    const record = await tx.financeImportMappingTemplate.findUnique({ where: { id }, select: { id: true, kind: true, headersDigest: true } });
    if (!record) throw new ActionError("映射模板不存在");
    await tx.financeImportMappingTemplate.delete({ where: { id } });
    await auditTx(tx, {
      userId: viewer.id,
      action: "FINANCE_IMPORT_MAPPING_TEMPLATE_DELETE",
      targetType: "FinanceImportMappingTemplate",
      targetId: id,
      detail: { kind: record.kind, headersDigest: record.headersDigest }
    });
  });
}
