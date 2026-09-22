import { describe, expect, it } from "vitest";
import { copyBuiltinGrants, hasCustomPermission, PERMISSIONS, scopeFor } from "@/lib/roles/catalog";

describe("经营财务权限", () => {
  it("新增财务权限只允许全所范围且财务岗位明确获得", () => {
    const keys = ["finance.import", "finance.reconcile", "finance.rules", "finance.adjust", "finance.export"] as const;
    for (const key of keys) {
      expect(PERMISSIONS.find(permission => permission.key === key)?.scopes).toEqual(["ALL"]);
      expect(copyBuiltinGrants("FINANCE")).toContainEqual({ permissionKey: key, scope: "ALL" });
    }
  });

  it("自定义律师没有新财务写权限", () => {
    const user = { role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read" as const, scope: "ALL" as const }] };
    expect(hasCustomPermission(user, "finance.read")).toBe(true);
    expect(hasCustomPermission(user, "finance.import")).toBe(false);
    expect(hasCustomPermission(user, "finance.adjust")).toBe(false);
  });

  it("业务管理权不能自动产生规则发布和调整权限", () => {
    const user = { role: "CUSTOM", managerAuthorized: true, rolePermissions: [{ permissionKey: "finance.read" as const, scope: "ALL" as const }] };
    expect(scopeFor(user, "finance.rules")).toBeUndefined();
    expect(scopeFor(user, "finance.adjust")).toBeUndefined();
  });
});
