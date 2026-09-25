import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { financeImportKindSchema, MAX_FINANCE_IMPORT_BYTES } from "@/server/finance/internal-schemas";
import { commitFinanceImport } from "@/server/finance/internal-imports";
import { ensurePrivateFinanceImportActor } from "@/server/finance/private-finance-import-actor";

const PRIVATE_INPUT_DIRECTORY = "/run/lawlink-finance-private-import";
const ALLOWED_EXTENSIONS = new Set(["csv", "xlsx", "xls", "pdf"]);
const ALLOWED_KINDS = new Set(["BANK_STATEMENT", "PAYROLL", "ROSTER", "EXTERNAL_THREE_STATEMENTS"]);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("受控导入参数缺失");
  return value;
}

async function readPrivateInput(extension: string): Promise<Buffer> {
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("受控导入文件类型不支持");
  const directory = await realpath(PRIVATE_INPUT_DIRECTORY);
  if (directory !== PRIVATE_INPUT_DIRECTORY) throw new Error("受控导入目录校验失败");
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error("受控导入目录权限不安全");
  }

  const sourcePath = join(directory, `source.${extension}`);
  const sourceInfo = await lstat(sourcePath);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size < 1 ||
    sourceInfo.size > MAX_FINANCE_IMPORT_BYTES ||
    (sourceInfo.mode & 0o077) !== 0
  ) {
    throw new Error("受控导入文件校验失败");
  }
  if (typeof process.getuid === "function" && sourceInfo.uid !== process.getuid()) {
    throw new Error("受控导入文件所有者不符");
  }
  if (await realpath(sourcePath) !== sourcePath) throw new Error("受控导入文件路径校验失败");
  return readFile(sourcePath);
}

async function main(): Promise<void> {
  const extension = requiredEnvironment("FINANCE_IMPORT_EXTENSION").toLowerCase();
  const parsedKind = financeImportKindSchema.safeParse(requiredEnvironment("FINANCE_IMPORT_KIND"));
  if (!parsedKind.success || !ALLOWED_KINDS.has(parsedKind.data)) throw new Error("受控导入资料类型不支持");
  const kind = parsedKind.data;
  const period = process.env.FINANCE_IMPORT_PERIOD?.trim() || undefined;
  const asOfDay = process.env.FINANCE_IMPORT_AS_OF_DAY?.trim() || undefined;
  const bytes = await readPrivateInput(extension);
  const actor = await ensurePrivateFinanceImportActor(prisma);
  const periodLabel = period ?? asOfDay?.slice(0, 7) ?? "undated";
  const fileName = `private-${kind.toLowerCase()}-${periodLabel}.${extension}`;
  const result = await commitFinanceImport({ fileName, kind, bytes, period, asOfDay }, {
    db: prisma,
    storage,
    actorId: actor.id
  });

  process.stdout.write(`${JSON.stringify({ kind, duplicate: result.duplicate, batchId: result.batchId })}\n`);
}

main().catch(() => {
  process.stderr.write("受控财务导入失败；来源内容未输出。\n");
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
