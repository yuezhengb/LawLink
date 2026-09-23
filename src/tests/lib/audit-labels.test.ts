/**
 * 审计标签完整性（第七轮体检）。
 *
 * auditActionLabel 按词拼装：action 的任何一个词未在 words 中登记，整条即降级为
 * 「其他操作（详见技术详情）」。补词是新增审计动作时最容易漏的一步，而漏掉的
 * 代价落在审计页可读性上——体检当时全仓 199 个 action 有 48 个命中降级，其中含
 * 证件号/电话明文查看、财务更正、二次验证变更等敏感操作。
 *
 * 本测试扫描全仓 action/targetType 字面量做元断言，防止同类回归。
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { auditActionLabel, auditTargetLabel } from "@/lib/audit-labels";

function scan(pattern: string): string[] {
  const out = execSync(`grep -rhoE '${pattern}' src/server src/app src/lib || true`, {
    encoding: "utf-8",
    cwd: process.cwd()
  });
  return [...new Set([...out.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]))].sort();
}

describe("审计动作标签", () => {
  it("全仓每个 action 都能拼出中文，不落到「其他操作」", () => {
    const actions = scan('action: ?"[A-Z_]+"');
    expect(actions.length).toBeGreaterThan(150); // 扫描确实生效
    const degraded = actions.filter((a) => auditActionLabel(a) === "其他操作（详见技术详情）");
    expect(degraded, `以下动作缺词条，请补 src/lib/audit-labels.ts 的 words：\n${degraded.join("\n")}`).toEqual([]);
  });

  it("全仓每个 targetType 都有中文标签，不落到「其他对象」", () => {
    const types = scan('targetType: ?"[A-Za-z]+"');
    expect(types.length).toBeGreaterThan(40);
    const degraded = types.filter((t) => auditTargetLabel(t) === "其他对象");
    expect(degraded, `以下对象缺标签，请补 src/lib/audit-labels.ts 的 targetLabels：\n${degraded.join("\n")}`).toEqual([]);
  });

  it("本轮补齐的敏感操作可读", () => {
    expect(auditActionLabel("CLIENT_ID_REVEAL")).toBe("客户 · 证件号 · 查看明文");
    expect(auditActionLabel("ARCHIVE_BORROW_RETURN")).toBe("归档 · 借阅 · 归还");
    expect(auditActionLabel("USER_TOTP_REBIND_RESET")).toBe("用户 · 二次验证 · 重新绑定 · 重置");
    expect(auditTargetLabel("ArchiveBorrowRequest")).toBe("案卷借阅申请");
  });

  it("律所财务分配的审计事件和对象有中文标签", () => {
    expect(auditActionLabel("FINANCE_INTERNAL_ALLOCATION_COMMIT")).toBe("财务 · 内账 · 分配 · 提交");
    expect(auditActionLabel("FINANCE_INTERNAL_REFUND_LINK")).toBe("财务 · 内账 · 退款 · 关联");
    expect(auditTargetLabel("FinanceAllocationRecipient")).toBe("律师分配明细");
  });
});
