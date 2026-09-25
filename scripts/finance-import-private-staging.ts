import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseFinanceSource } from "@/lib/finance/finance-source-parser";
import { inspectFinanceHeader } from "@/lib/finance/import-mapping";
import { readFinanceWorkbookSheets } from "@/lib/finance/import-parser";
import {
  classifyFinanceSourceSheets,
  classifyPrivateCellShape,
  summarizePrivateFinanceParses,
  summarizePrivateStaging,
  type PrivateFinanceParseEntry,
  type PrivateStagingEntry
} from "@/lib/finance/private-staging-inventory";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_LOCAL_EXTENSIONS = new Set([".csv", ".xlsx"]);
const PREPROCESSOR_EXTENSIONS = new Set([".xls", ".pdf"]);

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function inspectFile(path: string): Promise<{ inventory: PrivateStagingEntry; parse?: PrivateFinanceParseEntry }> {
  const extension = extname(path).toLowerCase() || ".unknown";
  const stat = await lstat(path);
  let sha256 = "";
  let unreadable = stat.size <= 0 || stat.size > MAX_SOURCE_BYTES;
  let unsupported = false;
  let needsPreprocessing = false;
  let kind: PrivateStagingEntry["kind"] = "UNCLASSIFIED";
  let parse: PrivateFinanceParseEntry | undefined;
  let analysisSheets: Array<{ name: string; matrix: string[][] }> = [];

  if (unreadable) {
    unsupported = stat.size > MAX_SOURCE_BYTES;
  } else {
    try {
      const bytes = await readFile(path);
      sha256 = createHash("sha256").update(bytes).digest("hex");
      if (PREPROCESSOR_EXTENSIONS.has(extension)) {
        needsPreprocessing = true;
      } else if (SUPPORTED_LOCAL_EXTENSIONS.has(extension)) {
        const workbook = await readFinanceWorkbookSheets(bytes, `private-inventory${extension}`);
        if (workbook.errors.length) {
          unreadable = true;
        } else {
          analysisSheets = workbook.sheets;
          kind = classifyFinanceSourceSheets(workbook.sheets);
          const parseKind = kind === "BANK_STATEMENT" || kind === "PAYROLL" || kind === "ROSTER" || kind === "EXTERNAL_THREE_STATEMENTS"
            ? kind
            : null;
          if (parseKind) {
            try {
              const result = await parseFinanceSource(bytes, `private-inventory${extension}`, parseKind);
              const periods = result.rows.flatMap((row) => {
                if ("occurredAt" in row) return [row.occurredAt.slice(0, 7)];
                if ("period" in row) return [row.period];
                if ("asOfDay" in row) return [row.asOfDay.slice(0, 7)];
                return [];
              });
              const errorShapes = result.errors.flatMap((error) => {
                if (error.code !== "INVALID_AMOUNT") return [];
                const sheet = analysisSheets.find((candidate) => candidate.name === error.sourceSheet) ?? analysisSheets[0];
                if (!sheet || error.rowNumber < 1) return ["unmapped:UNMAPPED"];
                const inspected = inspectFinanceHeader(parseKind, sheet.matrix);
                if (!inspected) return ["unmapped:UNMAPPED"];
                const field = parseKind === "BANK_STATEMENT"
                  ? ({ "金额": "amount", "余额": "balance", "借方金额": "debit", "贷方金额": "credit" } as Record<string, string>)[error.field ?? ""]
                  : error.field;
                const column = field ? inspected.mapping[field as keyof typeof inspected.mapping] : undefined;
                if (column === undefined) return ["unmapped:UNMAPPED"];
                return [`${field}:${classifyPrivateCellShape(sheet.matrix[error.rowNumber - 1]?.[column] ?? "")}`];
              });
              parse = {
                kind: parseKind,
                sha256,
                rowCount: result.rows.length,
                errorCodes: result.errors.map((error) => String(error.code)),
                errorFields: result.errors.map((error) => error.field ?? "unspecified"),
                errorShapes,
                periods
              };
            } catch {
              parse = { kind: parseKind, sha256, rowCount: 0, errorCodes: ["PARSER_FAILURE"], errorFields: ["unspecified"], errorShapes: ["unmapped:UNMAPPED"], periods: [] };
            }
          }
        }
      } else {
        unsupported = true;
      }
    } catch {
      unreadable = true;
    }
  }

  return {
    inventory: { extension, sha256, kind, needsPreprocessing, unreadable, unsupported },
    parse
  };
}

async function main(): Promise<void> {
  const inputDirectory = process.argv[2];
  if (!inputDirectory) throw new Error("missing directory");
  const absoluteDirectory = await realpath(resolve(inputDirectory));
  const rootInfo = await lstat(absoluteDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("invalid directory");

  const files = await walkFiles(absoluteDirectory);
  const inspected: Array<Awaited<ReturnType<typeof inspectFile>>> = [];
  for (const file of files) inspected.push(await inspectFile(file));
  process.stdout.write(`${JSON.stringify({
    inventory: summarizePrivateStaging(inspected.map((file) => file.inventory)),
    parse: summarizePrivateFinanceParses(inspected.flatMap((file) => file.parse ? [file.parse] : []))
  })}\n`);
}

main().catch(() => {
  process.stderr.write("无法安全完成私有资料清点。\n");
  process.exitCode = 1;
});
