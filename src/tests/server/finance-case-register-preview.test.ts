import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { previewCaseRegisterFile, type CaseRegisterPreviewDependencies } from "@/server/finance/case-register-preview";

async function workbookBytes() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("合成清单名");
  sheet.addRow(["内部标题"]);
  sheet.addRow(["合同编号", "所内案号", "客户名称"]);
  sheet.addRow(["SYN-C-1", "SYN-M-1", "不得进入返回值"]);
  sheet.addRow(["SYN-C-2", "ONLY-REGISTER", "不得进入返回值"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function dependencies() {
  const auditStrict = vi.fn().mockResolvedValue(undefined);
  const db = {
    matter: { findMany: vi.fn().mockResolvedValue([
      { internalCode: "SYN-M-1", firmCaseNo: "FIRM-M-1" },
      { internalCode: "SYSTEM-ONLY", firmCaseNo: null }
    ]) }
  };
  return { auditStrict, db, deps: { db: db as never, auditStrict } satisfies CaseRegisterPreviewDependencies };
}

describe("案件登记清单只读预览服务", () => {
  it("只读取案件编号字段，审计只写聚合数且返回中不含客户名", async () => {
    const { db, auditStrict, deps } = dependencies();
    const result = await previewCaseRegisterFile({
      fileName: "synthetic.xlsx",
      bytes: await workbookBytes(),
      actor: { id: "finance-user", role: "FINANCE" }
    }, deps);

    expect(result.counts).toMatchObject({ totalRows: 2, comparableRows: 2, matched: 1, registerOnly: 1, systemOnly: 1, contractNumbersUncompared: 2 });
    expect(result.differences).toContainEqual({ status: "REGISTER_ONLY", caseNumber: "ONLY-REGISTER", contractNumber: "SYN-C-2" });
    expect(JSON.stringify(result)).not.toContain("不得进入返回值");
    expect(db.matter.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { internalCode: true, firmCaseNo: true } }));
    expect(auditStrict).toHaveBeenCalledOnce();
    const auditText = JSON.stringify(auditStrict.mock.calls[0][0]);
    expect(auditText).toContain("registerOnly");
    expect(auditText).not.toContain("SYN-");
    expect(auditText).not.toContain("synthetic.xlsx");
  });

  it("权限不足时不查案件库", async () => {
    const { db, deps } = dependencies();
    await expect(previewCaseRegisterFile({
      fileName: "synthetic.xlsx", bytes: await workbookBytes(), actor: { id: "lawyer", role: "LAWYER" }
    }, deps)).rejects.toThrow("无财务资料导入权限");
    expect(db.matter.findMany).not.toHaveBeenCalled();
  });

  it("拒绝不支持的扩展名、过大的文件与无编号列的工作簿", async () => {
    const { deps } = dependencies();
    const actor = { id: "finance-user", role: "FINANCE" };
    await expect(previewCaseRegisterFile({ fileName: "source.xls", bytes: Buffer.from("x"), actor }, deps)).rejects.toThrow("仅支持 XLSX 或 XLSM 案件登记清单");
    await expect(previewCaseRegisterFile({ fileName: "source.xlsx", bytes: Buffer.alloc(15 * 1024 * 1024 + 1), actor }, deps)).rejects.toThrow("案件登记清单超过安全文件大小限制");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("合成表").addRows([["人员"], ["合成"]]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(previewCaseRegisterFile({ fileName: "source.xlsx", bytes, actor }, deps)).rejects.toThrow("未找到可识别的案件或合同编号列");
  });
});
