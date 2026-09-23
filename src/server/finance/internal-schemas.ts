import { z } from "zod";

export const MAX_FINANCE_IMPORT_BYTES = 25 * 1024 * 1024;

export const financeImportKindSchema = z.enum([
  "BANK_STATEMENT",
  "PAYROLL",
  "ROSTER",
  "EXTERNAL_THREE_STATEMENTS",
  "OTHER"
]);

export const financeColumnMappingSchema = z
  .object({
    occurredAt: z.string().trim().min(1).max(120).optional(),
    counterparty: z.string().trim().min(1).max(120).optional(),
    debit: z.string().trim().min(1).max(120).optional(),
    credit: z.string().trim().min(1).max(120).optional(),
    amount: z.string().trim().min(1).max(120).optional(),
    balance: z.string().trim().min(1).max(120).optional(),
    account: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(120).optional(),
    externalReference: z.string().trim().min(1).max(120).optional(),
    invoiceReference: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const financePeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "期间必须是 YYYY-MM");

export const commitFinanceImportSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  kind: financeImportKindSchema,
  bytes: z.custom<Buffer>((value) => Buffer.isBuffer(value), "导入内容必须是二进制文件"),
  mapping: financeColumnMappingSchema.optional(),
  period: financePeriodSchema.optional(),
  asOfDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const sourceDownloadSchema = z.object({
  id: z.string().trim().min(1).max(100)
});

export type FinanceImportKindInput = z.infer<typeof financeImportKindSchema>;
