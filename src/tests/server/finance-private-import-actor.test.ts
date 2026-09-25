import { describe, expect, it, vi } from "vitest";
import {
  ensurePrivateFinanceImportActor,
  PRIVATE_FINANCE_IMPORT_ACTOR_EMAIL,
  PRIVATE_FINANCE_IMPORT_ACTOR_NAME
} from "@/server/finance/private-finance-import-actor";

describe("受控财务导入审计主体", () => {
  it("只创建停用且无系统角色的专用审计账户，并且不返回口令", async () => {
    const create = vi.fn().mockResolvedValue({ id: "synthetic-import-actor" });
    const db = { user: { findUnique: vi.fn().mockResolvedValue(null), create } };
    const hashPassword = vi.fn().mockResolvedValue("synthetic-password-hash");

    const actor = await ensurePrivateFinanceImportActor(db as never, hashPassword);

    expect(actor).toEqual({ id: "synthetic-import-actor" });
    expect(hashPassword).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: PRIVATE_FINANCE_IMPORT_ACTOR_NAME,
        email: PRIVATE_FINANCE_IMPORT_ACTOR_EMAIL,
        passwordHash: "synthetic-password-hash",
        role: "CUSTOM",
        roleDefinitionId: null,
        systemRole: "NONE",
        active: false
      }),
      select: { id: true }
    });
    expect(JSON.stringify(actor)).not.toContain("password");
  });

  it("只复用既有且仍停用的专用账户", async () => {
    const create = vi.fn();
    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "synthetic-import-actor",
          name: PRIVATE_FINANCE_IMPORT_ACTOR_NAME,
          role: "CUSTOM",
          roleDefinitionId: null,
          systemRole: "NONE",
          active: false
        }),
        create
      }
    };

    await expect(ensurePrivateFinanceImportActor(db as never, vi.fn()))
      .resolves.toEqual({ id: "synthetic-import-actor" });
    expect(create).not.toHaveBeenCalled();
  });

  it("保留邮箱被活跃账号或其他身份占用时拒绝继续", async () => {
    const create = vi.fn();
    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "synthetic-conflict",
          name: "其他账号",
          role: "FINANCE",
          roleDefinitionId: null,
          systemRole: "NONE",
          active: true
        }),
        create
      }
    };

    await expect(ensurePrivateFinanceImportActor(db as never, vi.fn()))
      .rejects.toThrow("受控导入审计账户身份不符");
    expect(create).not.toHaveBeenCalled();
  });
});
