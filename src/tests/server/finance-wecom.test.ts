import { describe, expect, it, vi } from "vitest";
import {
  buildFinanceCloseMessage,
  getFinanceWecomSettings,
  previewFinanceWecomNotification,
  saveFinanceWecomSettings,
  sendFinanceWecomNotification,
  type FinanceWecomDependencies
} from "@/server/finance/finance-wecom";

const actor = { id: "finance-user", role: "FINANCE" } as const;
const webhook = "https://wecom.example.invalid/robot/send?key=synthetic-private-secret";

function settingsDatabase(value: unknown = null) {
  let stored: unknown = value;
  const model = {
    findUnique: vi.fn(async () => stored === null ? null : ({ key: "financeWecom", value: stored })),
    upsert: vi.fn(async (input: { create: { value: unknown }; update: { value: unknown } }) => {
      stored = input.update.value;
      return { key: "financeWecom", value: stored };
    })
  };
  const auditStrict = vi.fn().mockResolvedValue(undefined);
  const db = { systemSetting: model };
  return { db, model, auditStrict, deps: { db: db as never, auditStrict } satisfies FinanceWecomDependencies, readStored: () => stored };
}

describe("财务企微摘要通知", () => {
  it("未配置时默认关闭，管理 DTO 不含 webhook 或密文", async () => {
    const { deps } = settingsDatabase();
    const result = await getFinanceWecomSettings(actor, deps);
    expect(result).toEqual({ enabled: false, groupLabel: "", hasWebhook: false });
    expect(JSON.stringify(result)).not.toContain("webhook");
  });

  it("加密保存 webhook，管理接口只返回已配置状态和群标签", async () => {
    process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { deps, readStored, auditStrict } = settingsDatabase();
    const safeUrl = vi.fn(async (value: string) => new URL(value));
    await saveFinanceWecomSettings({ enabled: true, groupLabel: "财务内部群", webhookUrl: webhook }, actor, { ...deps, assertSafeUrl: safeUrl });
    const stored = JSON.stringify(readStored());
    expect(stored).not.toContain(webhook);
    expect(await getFinanceWecomSettings(actor, deps)).toEqual({ enabled: true, groupLabel: "财务内部群", hasWebhook: true });
    expect(auditStrict).toHaveBeenCalledOnce();
    expect(JSON.stringify(auditStrict.mock.calls[0][0])).not.toContain("private-secret");
  });

  it("预览只包含期间、月结状态、阻断数量和系统入口，不含案件详情或金额", async () => {
    const { deps } = settingsDatabase();
    const message = buildFinanceCloseMessage("2026-08", {
      period: "2026-08", ready: false, staleRun: false, sourceFiles: 3, sourceKinds: ["BANK_STATEMENT"],
      coverageConfirmed: false, transactionCount: 20, unresolvedCount: 4, unresolvedIncomeCount: 2, splitErrorCount: 0,
      missingPayrollCount: 1, templateWarnings: [], blockingWarnings: ["不得进入消息的敏感案件名称"], reviewWarnings: [], runId: null, sourceHash: null
    });
    const output = await previewFinanceWecomNotification("2026-08", actor, {
      ...deps,
      getCloseStatus: async () => ({
        period: "2026-08", ready: false, staleRun: false, sourceFiles: 3, sourceKinds: ["BANK_STATEMENT"],
        coverageConfirmed: false, transactionCount: 20, unresolvedCount: 4, unresolvedIncomeCount: 2, splitErrorCount: 0,
        missingPayrollCount: 1, templateWarnings: [], blockingWarnings: ["不得进入消息的敏感案件名称"], reviewWarnings: [], runId: null, sourceHash: null
      })
    });
    expect(output.message).toBe(message);
    expect(output.message).toContain("待处理事项：1 项");
    expect(output.message).not.toContain("不得进入消息的敏感案件名称");
    expect(output.message).not.toMatch(/¥|(?:\d+\.\d{2})/);
  });

  it("未勾选二次确认、关闭或未配置时绝不发送", async () => {
    const { deps } = settingsDatabase();
    const safeFetch = vi.fn();
    await expect(sendFinanceWecomNotification({ period: "2026-08", confirmed: false }, actor, { ...deps, safeFetch }))
      .rejects.toThrow("发送前必须明确确认");
    await expect(sendFinanceWecomNotification({ period: "2026-08", confirmed: true }, actor, { ...deps, safeFetch }))
      .rejects.toThrow("财务企微通知未配置或已关闭");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("发送按服务端生成摘要，安全校验并拒绝重定向，审计不含 URL 或正文", async () => {
    process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const { deps, auditStrict } = settingsDatabase();
    const safeUrl = vi.fn(async (value: string) => new URL(value));
    await saveFinanceWecomSettings({ enabled: true, groupLabel: "内部通知群", webhookUrl: webhook }, actor, { ...deps, assertSafeUrl: safeUrl });
    const safeFetch = vi.fn(async (_url: string, init?: Record<string, unknown>) => {
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(String(init?.body)).not.toContain("不得进入消息的敏感案件名称");
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    });
    const result = await sendFinanceWecomNotification({ period: "2026-08", confirmed: true }, actor, {
      ...deps,
      safeFetch,
      assertSafeUrl: safeUrl,
      getCloseStatus: async () => ({
        period: "2026-08", ready: true, staleRun: false, sourceFiles: 3, sourceKinds: ["BANK_STATEMENT"],
        coverageConfirmed: true, transactionCount: 20, unresolvedCount: 0, unresolvedIncomeCount: 0, splitErrorCount: 0,
        missingPayrollCount: 0, templateWarnings: [], blockingWarnings: ["不得进入消息的敏感案件名称"], reviewWarnings: [], runId: "run-1", sourceHash: "private-hash"
      })
    });
    expect(result).toEqual({ ok: true, groupLabel: "内部通知群", receipt: "已发送" });
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(safeUrl).toHaveBeenCalled();
    const auditText = JSON.stringify(auditStrict.mock.calls);
    expect(auditText).not.toContain("private-secret");
    expect(auditText).not.toContain("不得进入消息的敏感案件名称");
  });

  it("未授权用户不能读取或修改配置", async () => {
    const { deps, model } = settingsDatabase();
    const intruder = { id: "lawyer", role: "LAWYER" };
    await expect(getFinanceWecomSettings(intruder, deps)).rejects.toThrow("无财务企微管理权限");
    await expect(saveFinanceWecomSettings({ enabled: false, groupLabel: "" }, intruder, deps)).rejects.toThrow("无财务企微管理权限");
    expect(model.findUnique).not.toHaveBeenCalled();
    expect(model.upsert).not.toHaveBeenCalled();
  });
});
