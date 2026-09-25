import { describe, expect, it } from "vitest";
import { applyFinanceColumnMapping, suggestFinanceColumnMapping } from "@/lib/finance/import-mapping";

describe("财务导入字段映射", () => {
  it("按律所常用字段名建议类型化导入列且不读取行值", () => {
    expect(suggestFinanceColumnMapping("PAYROLL", ["月份", "员工姓名", "应发工资", "实发工资", "个人社保"]).mapping)
      .toMatchObject({ period: 0, name: 1, salary: 2, actual: 3, selfCost: 4 });
  });

  it("显式映射覆盖自动建议并按列索引读取", () => {
    const mapping = { name: 2, salary: 0, actual: 1, selfCost: 3 };
    const row = applyFinanceColumnMapping(["应发工资", "实付", "姓名", "个人承担"], ["15000", "12000", "合成人员", "800"], mapping);

    expect(row).toEqual({ name: "合成人员", salary: "15000", actual: "12000", selfCost: "800" });
  });

  it("必需字段缺失时给出系统字段列表，不假定金额或期间", () => {
    expect(suggestFinanceColumnMapping("PAYROLL", ["姓名", "工资"]).missingFields).toEqual(expect.arrayContaining(["actual", "selfCost"]));
  });
});
