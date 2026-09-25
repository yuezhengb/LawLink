const MAX_CASE_REGISTER_ROWS = 5000;

export type CaseRegisterMatterIdentifier = { internalCode: string; firmCaseNo: string | null };
export type CaseRegisterDifference = {
  status: "REGISTER_ONLY" | "SYSTEM_ONLY" | "DUPLICATE_REGISTER";
  caseNumber: string;
  contractNumber: string | null;
};
export type CaseRegisterReconciliation = {
  counts: {
    totalRows: number;
    comparableRows: number;
    matched: number;
    registerOnly: number;
    systemOnly: number;
    duplicateRegister: number;
    contractNumbersUncompared: number;
  };
  differences: CaseRegisterDifference[];
  warnings: string[];
};

const CASE_NUMBER_HEADERS = new Set([
  "所内案号", "案号", "案件编号", "案件号", "律所案号", "lawlink案号", "firmcaseno", "internalcode"
]);
const CONTRACT_NUMBER_HEADERS = new Set(["合同编号", "合同号", "委托合同编号", "委托合同号", "contractno", "contractnumber"]);

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").replace(/[\s_\-]/g, "").toLocaleLowerCase();
}

function normalizeCaseNumber(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u00a0\u200b\uFEFF]/g, "").toLocaleUpperCase();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const cell = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }> };
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => String(part.text ?? "")).join("").trim();
    if (cell.text !== undefined) return String(cell.text).trim();
    if (cell.result !== undefined) return cellText(cell.result);
    return "";
  }
  return String(value).trim();
}

export function findCaseRegisterHeader(headers: string[]): { caseColumn: number; contractColumn: number } {
  return {
    caseColumn: headers.findIndex((header) => CASE_NUMBER_HEADERS.has(normalizeHeader(header))),
    contractColumn: headers.findIndex((header) => CONTRACT_NUMBER_HEADERS.has(normalizeHeader(header)))
  };
}

export function reconcileCaseRegister(input: {
  headers: string[];
  rows: string[][];
  matters: CaseRegisterMatterIdentifier[];
}): CaseRegisterReconciliation {
  const { caseColumn, contractColumn } = findCaseRegisterHeader(input.headers);
  if (caseColumn < 0 && contractColumn < 0) throw new Error("未找到可识别的案件或合同编号列");

  const dataRows = input.rows.filter((row) => row.some((value) => cellText(value) !== ""));
  if (dataRows.length > MAX_CASE_REGISTER_ROWS) throw new Error("案件清单超过安全行数限制");

  const systemIdentifiers = new Set<string>();
  const matterIdentifiers = input.matters.map((matter) => {
    const identifiers = [matter.internalCode, matter.firmCaseNo ?? ""]
      .map(normalizeCaseNumber)
      .filter(Boolean);
    identifiers.forEach((identifier) => systemIdentifiers.add(identifier));
    return identifiers;
  });

  const registerCounts = new Map<string, { display: string; contractNumber: string | null; count: number }>();
  let comparableRows = 0;
  let contractNumbersUncompared = 0;
  for (const row of dataRows) {
    const display = caseColumn < 0 ? "" : cellText(row[caseColumn]);
    const normalized = normalizeCaseNumber(display);
    const contractNumber = contractColumn >= 0 ? cellText(row[contractColumn]) || null : null;
    if (contractNumber) contractNumbersUncompared += 1;
    if (!normalized) continue;
    comparableRows += 1;
    const current = registerCounts.get(normalized);
    if (current) current.count += 1;
    else registerCounts.set(normalized, { display, contractNumber, count: 1 });
  }

  const matchedMatterIndexes = new Set<number>();
  if (caseColumn >= 0) {
    matterIdentifiers.forEach((identifiers, index) => {
      if (identifiers.some((identifier) => registerCounts.has(identifier))) matchedMatterIndexes.add(index);
    });
  }
  const differences: CaseRegisterDifference[] = [];
  let registerOnly = 0;
  let duplicateRegister = 0;
  for (const [number, entry] of registerCounts) {
    if (entry.count > 1) {
      duplicateRegister += entry.count - 1;
      differences.push({ status: "DUPLICATE_REGISTER", caseNumber: entry.display, contractNumber: entry.contractNumber });
    } else if (!systemIdentifiers.has(number)) {
      registerOnly += 1;
      differences.push({ status: "REGISTER_ONLY", caseNumber: entry.display, contractNumber: entry.contractNumber });
    }
  }

  let systemOnly = 0;
  for (const [index, matter] of input.matters.entries()) {
    const canonicalNumber = matter.firmCaseNo?.trim() || matter.internalCode;
    const normalized = normalizeCaseNumber(canonicalNumber);
    if (caseColumn >= 0 && normalized && !matchedMatterIndexes.has(index)) {
      systemOnly += 1;
      differences.push({ status: "SYSTEM_ONLY", caseNumber: canonicalNumber, contractNumber: null });
    }
  }

  return {
    counts: {
      totalRows: dataRows.length,
      comparableRows,
      matched: matchedMatterIndexes.size,
      registerOnly,
      systemOnly,
      duplicateRegister,
      contractNumbersUncompared
    },
    differences: differences.slice(0, 500),
    warnings: caseColumn < 0
      ? ["未找到可与系统案号字段精确比对的清单列；合同编号未作案号使用。"]
      : contractColumn >= 0
        ? ["系统没有独立合同编号字段；合同编号仅作清单参考，未与案号匹配。"]
        : ["清单中没有可识别的合同编号列。"]
  };
}

export function caseRegisterCellText(value: unknown): string {
  return cellText(value);
}
