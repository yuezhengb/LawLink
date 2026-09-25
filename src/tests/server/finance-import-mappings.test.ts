import { describe, expect, it, vi } from "vitest";
import {
  listFinanceImportMappingTemplates,
  saveFinanceImportMappingTemplate,
  type FinanceMappingTemplateDependencies
} from "@/server/finance/finance-import-mappings";

function database() {
  const model = {
    findMany: vi.fn().mockResolvedValue([{
      id: "template-1",
      kind: "PAYROLL",
      headersDigest: "a".repeat(64),
      mapping: { name: 0, salary: 1, actual: 2, selfCost: 3 },
      createdById: "finance-user",
      updatedAt: new Date("2026-08-01T00:00:00Z")
    }]),
    upsert: vi.fn().mockResolvedValue({
      id: "template-1",
      kind: "PAYROLL",
      headersDigest: "a".repeat(64),
      mapping: { name: 0, salary: 1, actual: 2, selfCost: 3 },
      updatedAt: new Date("2026-08-01T00:00:00Z")
    })
  };
  const tx = { financeImportMappingTemplate: model, auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) } };
  const db = {
    financeImportMappingTemplate: model,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  };
  return { db, tx };
}

function depsFor(db: ReturnType<typeof database>["db"]): FinanceMappingTemplateDependencies {
  return { db: db as never };
}

describe("财务字段映射模板", () => {
  it("仅保存字段到列索引，不保存原始表头或样例数据，并写审计", async () => {
    const { db, tx } = database();

    const result = await saveFinanceImportMappingTemplate({
      kind: "PAYROLL",
      headersDigest: "a".repeat(64),
      mapping: { name: 0, salary: 1, actual: 2, selfCost: 3 }
    }, { id: "finance-user", role: "FINANCE" }, depsFor(db));

    expect(result).toMatchObject({ id: "template-1", kind: "PAYROLL", headersDigest: "a".repeat(64) });
    expect(tx.financeImportMappingTemplate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind_headersDigest: { kind: "PAYROLL", headersDigest: "a".repeat(64) } },
      create: expect.objectContaining({ kind: "PAYROLL", headersDigest: "a".repeat(64), mapping: { name: 0, salary: 1, actual: 2, selfCost: 3 }, createdById: "finance-user" })
    }));
    const persisted = JSON.stringify(tx.financeImportMappingTemplate.upsert.mock.calls[0][0]);
    expect(persisted).not.toContain("人员姓名");
    expect(persisted).not.toContain("不得落库的合成样例");
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("createdById");
  });

  it("未授权角色不能读取模板", async () => {
    const { db } = database();

    await expect(listFinanceImportMappingTemplates("PAYROLL", { id: "lawyer", role: "LAWYER" }, depsFor(db)))
      .rejects.toThrow("无财务资料导入权限");
    expect(db.financeImportMappingTemplate.findMany).not.toHaveBeenCalled();
  });

  it("拒绝越界列索引", async () => {
    const { db } = database();

    await expect(saveFinanceImportMappingTemplate({
      kind: "PAYROLL",
      headersDigest: "a".repeat(64),
      mapping: { salary: 5000 }
    }, { id: "finance-user", role: "FINANCE" }, depsFor(db))).rejects.toThrow("映射模板内容不正确");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
