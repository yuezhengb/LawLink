import { describe, expect, it } from "vitest";
import {
  reconcileCaseRegister,
  type CaseRegisterMatterIdentifier
} from "@/lib/finance/case-register-reconciliation";

const matters: CaseRegisterMatterIdentifier[] = [
  { internalCode: "LAW-2026-001", firmCaseNo: "民初-2026-001" },
  { internalCode: "LAW-2026-002", firmCaseNo: null },
  { internalCode: "LAW-2026-003", firmCaseNo: "民初-2026-003" }
];

describe("案件登记清单只读差异比对", () => {
  it("按 NFKC、去空白后的完整案号精确匹配，不按近似编号匹配", () => {
    const result = reconcileCaseRegister({
      headers: ["合同编号", "所内案号", "客户名称"],
      rows: [
        ["CONTRACT-01", "民初 - 2026 - 001", "不得输出的客户"],
        ["CONTRACT-02", "民初-2026-00l", "不得输出的客户"],
        ["CONTRACT-03", "不存在案号", "不得输出的客户"]
      ],
      matters
    });

    expect(result.counts).toMatchObject({ totalRows: 3, comparableRows: 3, matched: 1, registerOnly: 2, systemOnly: 2, duplicateRegister: 0, contractNumbersUncompared: 3 });
    expect(result.differences).toEqual([
      { status: "REGISTER_ONLY", caseNumber: "民初-2026-00l", contractNumber: "CONTRACT-02" },
      { status: "REGISTER_ONLY", caseNumber: "不存在案号", contractNumber: "CONTRACT-03" },
      { status: "SYSTEM_ONLY", caseNumber: "LAW-2026-002", contractNumber: null },
      { status: "SYSTEM_ONLY", caseNumber: "民初-2026-003", contractNumber: null }
    ]);
    expect(JSON.stringify(result)).not.toContain("不得输出的客户");
  });

  it("报告重复清单案号，且不把合同编号误当案号", () => {
    const result = reconcileCaseRegister({
      headers: ["合同编号", "客户名称"],
      rows: [["C-1", "客户一"], ["C-1", "客户二"]],
      matters
    });

    expect(result.counts).toMatchObject({ totalRows: 2, comparableRows: 0, duplicateRegister: 0, contractNumbersUncompared: 2 });
    expect(result.differences).toHaveLength(0);
    expect(result.warnings).toContain("未找到可与系统案号字段精确比对的清单列；合同编号未作案号使用。");
  });

  it("同一案号重复登记只计一次匹配，其余标记为重复", () => {
    const result = reconcileCaseRegister({
      headers: ["案号"],
      rows: [["LAW-2026-001"], ["LAW-2026-001"]],
      matters
    });

    expect(result.counts).toMatchObject({ totalRows: 2, comparableRows: 2, matched: 1, duplicateRegister: 1 });
    expect(result.differences).toEqual([
      { status: "DUPLICATE_REGISTER", caseNumber: "LAW-2026-001", contractNumber: null },
      { status: "SYSTEM_ONLY", caseNumber: "LAW-2026-002", contractNumber: null },
      { status: "SYSTEM_ONLY", caseNumber: "民初-2026-003", contractNumber: null }
    ]);
  });

  it("拒绝无案号列或超出有界清单", () => {
    expect(() => reconcileCaseRegister({ headers: ["姓名"], rows: [["合成"]], matters })).toThrow("未找到可识别的案件或合同编号列");
    expect(() => reconcileCaseRegister({ headers: ["案号"], rows: Array.from({ length: 5001 }, () => ["x"]), matters })).toThrow("案件清单超过安全行数限制");
  });
});
