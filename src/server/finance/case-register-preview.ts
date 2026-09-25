import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { ActionError } from "@/lib/action-error";
import {
  caseRegisterCellText,
  findCaseRegisterHeader,
  reconcileCaseRegister,
  type CaseRegisterReconciliation
} from "@/lib/finance/case-register-reconciliation";
import { prisma } from "@/lib/prisma";
import { auditStrict as auditStrictDefault } from "@/server/audit";
import { canManageFinanceImports, type FinanceImportViewer } from "@/server/finance/internal-imports";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_SHEETS = 30;
const MAX_ROWS = 5000;
const MAX_HEADER_SCAN = 40;
const MAX_COLUMNS = 256;

export type CaseRegisterPreviewDependencies = {
  db?: Pick<PrismaClient, "matter">;
  auditStrict?: typeof auditStrictDefault;
};

export type CaseRegisterPreviewInput = {
  fileName: string;
  bytes: Buffer;
  actor: FinanceImportViewer;
};

export type CaseRegisterPreviewResult = CaseRegisterReconciliation & {
  sheetsReviewed: number;
  sheetsSkipped: number;
};

function readRow(row: ExcelJS.Row): Map<number, string> {
  const values = new Map<number, string>();
  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    if (columnNumber <= MAX_COLUMNS) values.set(columnNumber - 1, caseRegisterCellText(cell.value));
  });
  return values;
}

async function extractRegisterRows(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as never);
  } catch {
    throw new ActionError("案件登记清单无法读取，请确认文件未损坏或加密。");
  }
  if (!workbook.worksheets.length || workbook.worksheets.length > MAX_SHEETS) {
    throw new ActionError("案件登记清单工作表数量超出安全范围。");
  }

  const rows: string[][] = [];
  let hasCaseNumberColumn = false;
  let hasContractNumberColumn = false;
  let sheetsReviewed = 0;
  let sheetsSkipped = 0;

  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > MAX_ROWS + MAX_HEADER_SCAN || sheet.columnCount > MAX_COLUMNS) {
      throw new ActionError("案件登记清单超过安全行数或列数限制。");
    }
    let headerRowNumber = 0;
    let caseColumn = -1;
    let contractColumn = -1;
    const scanUntil = Math.min(sheet.rowCount, MAX_HEADER_SCAN);
    for (let rowNumber = 1; rowNumber <= scanUntil; rowNumber += 1) {
      const values = readRow(sheet.getRow(rowNumber));
      const width = Math.max(0, ...[...values.keys()].map((column) => column + 1));
      const headers = Array.from({ length: width }, (_, index) => values.get(index) ?? "");
      const mapping = findCaseRegisterHeader(headers);
      if (mapping.caseColumn >= 0 || mapping.contractColumn >= 0) {
        headerRowNumber = rowNumber;
        caseColumn = mapping.caseColumn;
        contractColumn = mapping.contractColumn;
        break;
      }
    }
    if (!headerRowNumber) {
      sheetsSkipped += 1;
      continue;
    }
    sheetsReviewed += 1;
    hasCaseNumberColumn ||= caseColumn >= 0;
    hasContractNumberColumn ||= contractColumn >= 0;
    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const values = readRow(sheet.getRow(rowNumber));
      const caseNumber = caseColumn >= 0 ? values.get(caseColumn) ?? "" : "";
      const contractNumber = contractColumn >= 0 ? values.get(contractColumn) ?? "" : "";
      if (!caseNumber && !contractNumber) continue;
      rows.push([caseNumber, contractNumber]);
      if (rows.length > MAX_ROWS) throw new ActionError("案件清单超过安全行数限制");
    }
  }

  if (sheetsReviewed === 0) throw new ActionError("未找到可识别的案件或合同编号列");
  const headers = hasCaseNumberColumn
    ? hasContractNumberColumn ? ["案号", "合同编号"] : ["案号"]
    : ["合同编号"];
  const normalizedRows = rows.map((row) => hasCaseNumberColumn
    ? hasContractNumberColumn ? row : [row[0]]
    : [row[1]]);
  return { headers, rows: normalizedRows, sheetsReviewed, sheetsSkipped };
}

export async function previewCaseRegisterFile(
  input: CaseRegisterPreviewInput,
  dependencies: CaseRegisterPreviewDependencies = {}
): Promise<CaseRegisterPreviewResult> {
  if (!canManageFinanceImports(input.actor)) throw new ActionError("无财务资料导入权限");
  const extension = input.fileName.toLocaleLowerCase().split(".").pop();
  if (extension !== "xlsx" && extension !== "xlsm") throw new ActionError("仅支持 XLSX 或 XLSM 案件登记清单");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) throw new ActionError("案件登记清单超过安全文件大小限制");

  const extracted = await extractRegisterRows(input.bytes);
  const db = dependencies.db ?? prisma;
  const matters = await db.matter.findMany({ select: { internalCode: true, firmCaseNo: true } });
  const reconciliation = reconcileCaseRegister({ ...extracted, matters });
  const result: CaseRegisterPreviewResult = {
    ...reconciliation,
    sheetsReviewed: extracted.sheetsReviewed,
    sheetsSkipped: extracted.sheetsSkipped
  };

  const auditStrict = dependencies.auditStrict ?? auditStrictDefault;
  await auditStrict({
    userId: input.actor.id,
    action: "FINANCE_CASE_REGISTER_PREVIEW",
    targetType: "CaseRegisterPreview",
    detail: {
      ...result.counts,
      sheetsReviewed: result.sheetsReviewed,
      sheetsSkipped: result.sheetsSkipped,
      differenceRowsReturned: result.differences.length
    }
  });
  return result;
}
