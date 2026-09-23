import { describe, expect, it } from "vitest";
import { assessFinancePeriodCoverage } from "@/server/finance/internal-source-coverage";

describe("律所账期来源覆盖", () => {
  it("同一银行账户别名不能拆成重复条目规避覆盖核验", () => {
    const result = assessFinancePeriodCoverage({
      bankAccounts: [
        { alias: "基本户", batchIds: ["synthetic-bank-1"] },
        { alias: "基本户", batchIds: ["synthetic-bank-2"] }
      ],
      payrollBatchIds: [], noPayrollReason: "合成测试无工资资料",
      rosterBatchIds: [], noRosterReason: "合成测试不更新花名册",
      externalBatchIds: [], noExternalReason: "合成测试没有外账文件"
    }, [
      { id: "synthetic-bank-1", kind: "BANK_STATEMENT" },
      { id: "synthetic-bank-2", kind: "BANK_STATEMENT" }
    ]);

    expect(result.blockingWarnings).toContain("银行账户别名重复，请合并为一个账户覆盖项");
  });
});
