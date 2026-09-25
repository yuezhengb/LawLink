import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ActionError } from "@/lib/action-error";
import { decryptBuffer, encryptBuffer } from "@/lib/storage/crypto";
import { assertSafeHttpUrl, safeFetch } from "@/lib/net/safe-url";
import { prisma } from "@/lib/prisma";
import { scopeFor, type RoleGrant } from "@/lib/roles/catalog";
import { auditStrict as auditStrictDefault } from "@/server/audit";
import { getMonthlyCloseStatus, type MonthlyCloseActor, type MonthlyCloseStatus } from "@/server/finance/monthly-close";

const SETTING_KEY = "financeWecomNotification";
const SEND_TIMEOUT_MS = 8000;

export type FinanceWecomActor = { id: string; role: string; rolePermissions?: RoleGrant[] | null };
type EncryptedWebhook = { version: 1; ciphertext: string; iv: string; authTag: string; algorithm: "AES-256-GCM" };
type StoredSettings = { enabled: boolean; groupLabel: string; encryptedWebhook: EncryptedWebhook | null };
export type FinanceWecomDependencies = {
  db?: Pick<PrismaClient, "systemSetting">;
  auditStrict?: typeof auditStrictDefault;
  assertSafeUrl?: typeof assertSafeHttpUrl;
  safeFetch?: typeof safeFetch;
  getCloseStatus?: (period: string, actor: FinanceWecomActor) => Promise<MonthlyCloseStatus>;
};

const settingsInput = z.object({
  enabled: z.boolean(),
  groupLabel: z.string().trim().max(60).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "群标签不能包含控制字符"),
  webhookUrl: z.string().trim().max(2048).optional()
}).strict();

function assertManage(actor: FinanceWecomActor): void {
  if (actor.role === "FINANCE") return;
  if (actor.role === "CUSTOM") {
    const grants = { role: actor.role, rolePermissions: actor.rolePermissions ?? undefined };
    if (scopeFor(grants, "finance.read") === "ALL" && (scopeFor(grants, "finance.rules") === "ALL" || scopeFor(grants, "finance.adjust") === "ALL")) return;
  }
  throw new ActionError("无财务企微管理权限");
}

function emptySettings(): StoredSettings {
  return { enabled: false, groupLabel: "", encryptedWebhook: null };
}

function parseSettings(value: unknown): StoredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptySettings();
  const object = value as Record<string, unknown>;
  const candidate = object.encryptedWebhook && typeof object.encryptedWebhook === "object" && !Array.isArray(object.encryptedWebhook)
    ? object.encryptedWebhook as Record<string, unknown>
    : null;
  const encryptedWebhook = candidate && candidate.version === 1 && typeof candidate.ciphertext === "string" && typeof candidate.iv === "string" && typeof candidate.authTag === "string" && candidate.algorithm === "AES-256-GCM"
    ? candidate as unknown as EncryptedWebhook
    : null;
  return {
    enabled: object.enabled === true,
    groupLabel: typeof object.groupLabel === "string" ? object.groupLabel.slice(0, 60) : "",
    encryptedWebhook
  };
}

async function readStored(actor: FinanceWecomActor, dependencies: FinanceWecomDependencies): Promise<StoredSettings> {
  assertManage(actor);
  const db = dependencies.db ?? prisma;
  const row = await db.systemSetting.findUnique({ where: { key: SETTING_KEY }, select: { value: true } });
  return parseSettings(row?.value);
}

export async function getFinanceWecomSettings(actor: FinanceWecomActor, dependencies: FinanceWecomDependencies = {}): Promise<{ enabled: boolean; groupLabel: string; hasWebhook: boolean }> {
  const settings = await readStored(actor, dependencies);
  return { enabled: settings.enabled, groupLabel: settings.groupLabel, hasWebhook: Boolean(settings.encryptedWebhook) };
}

export async function saveFinanceWecomSettings(input: unknown, actor: FinanceWecomActor, dependencies: FinanceWecomDependencies = {}): Promise<{ enabled: boolean; groupLabel: string; hasWebhook: boolean }> {
  assertManage(actor);
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) throw new ActionError("财务企微配置格式不正确");
  const db = dependencies.db ?? prisma;
  const row = await db.systemSetting.findUnique({ where: { key: SETTING_KEY }, select: { value: true } });
  const current = parseSettings(row?.value);
  const webhookUrl = parsed.data.webhookUrl;
  let encryptedWebhook = current.encryptedWebhook;
  if (webhookUrl) {
    const assertSafeUrl = dependencies.assertSafeUrl ?? assertSafeHttpUrl;
    let url: URL;
    try { url = await assertSafeUrl(webhookUrl); } catch { throw new ActionError("Webhook 地址无法通过公网安全校验"); }
    if (url.protocol !== "https:") throw new ActionError("财务企微 Webhook 必须使用 HTTPS");
    const encrypted = encryptBuffer(Buffer.from(url.toString(), "utf8"));
    encryptedWebhook = {
      version: 1,
      ciphertext: encrypted.ciphertext.toString("base64"),
      iv: encrypted.iv.toString("base64"),
      authTag: encrypted.authTag.toString("base64"),
      algorithm: "AES-256-GCM"
    };
  }
  if (parsed.data.enabled && !encryptedWebhook) throw new ActionError("启用前必须配置 HTTPS Webhook");
  const next: StoredSettings = { enabled: parsed.data.enabled, groupLabel: parsed.data.groupLabel, encryptedWebhook };
  await db.systemSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: next },
    update: { value: next }
  });
  await (dependencies.auditStrict ?? auditStrictDefault)({
    userId: actor.id,
    action: "FINANCE_WECOM_SETTINGS_UPDATE",
    targetType: "SystemSetting",
    detail: { enabled: next.enabled, groupLabel: next.groupLabel, hasWebhook: Boolean(next.encryptedWebhook) }
  });
  return { enabled: next.enabled, groupLabel: next.groupLabel, hasWebhook: Boolean(next.encryptedWebhook) };
}

export function buildFinanceCloseMessage(period: string, status: MonthlyCloseStatus): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ActionError("月结期间格式不正确");
  return [
    "LawLink 财务月结提醒",
    `期间：${period}`,
    `状态：${status.ready ? "月结可交付" : "待核对"}`,
    `待处理事项：${status.blockingWarnings.length} 项`,
    `入口：/finance/internal/monthly-close?period=${period}`
  ].join("\n");
}

export async function previewFinanceWecomNotification(period: string, actor: FinanceWecomActor, dependencies: FinanceWecomDependencies = {}): Promise<{ groupLabel: string; enabled: boolean; hasWebhook: boolean; message: string }> {
  const settings = await readStored(actor, dependencies);
  const getStatus = dependencies.getCloseStatus ?? ((value, user) => getMonthlyCloseStatus(value, { actor: user as MonthlyCloseActor }));
  const status = await getStatus(period, actor);
  return {
    groupLabel: settings.groupLabel,
    enabled: settings.enabled,
    hasWebhook: Boolean(settings.encryptedWebhook),
    message: buildFinanceCloseMessage(period, status)
  };
}

function decryptWebhook(encrypted: EncryptedWebhook): string {
  try {
    return decryptBuffer(Buffer.from(encrypted.ciphertext, "base64"), encrypted.iv, encrypted.authTag).toString("utf8");
  } catch {
    throw new ActionError("财务企微密钥无法读取；请检查服务端加密密钥配置");
  }
}

export async function sendFinanceWecomNotification(
  input: { period: string; confirmed: boolean },
  actor: FinanceWecomActor,
  dependencies: FinanceWecomDependencies = {}
): Promise<{ ok: boolean; groupLabel: string; receipt: "已发送" | "发送失败" }> {
  assertManage(actor);
  if (input.confirmed !== true) throw new ActionError("发送前必须明确确认");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new ActionError("月结期间格式不正确");
  const settings = await readStored(actor, dependencies);
  if (!settings.enabled || !settings.encryptedWebhook) throw new ActionError("财务企微通知未配置或已关闭");

  const auditStrict = dependencies.auditStrict ?? auditStrictDefault;
  await auditStrict({
    userId: actor.id,
    action: "FINANCE_WECOM_SEND_ATTEMPT",
    targetType: "FinanceWecomNotification",
    detail: { period: input.period, groupLabel: settings.groupLabel }
  });

  const getStatus = dependencies.getCloseStatus ?? ((value, user) => getMonthlyCloseStatus(value, { actor: user as MonthlyCloseActor }));
  const status = await getStatus(input.period, actor);
  const message = buildFinanceCloseMessage(input.period, status);
  const urlString = decryptWebhook(settings.encryptedWebhook);
  let ok = false;
  let resultCode = "NETWORK_ERROR";
  try {
    const assertSafeUrl = dependencies.assertSafeUrl ?? assertSafeHttpUrl;
    const safeUrl = await assertSafeUrl(urlString);
    if (safeUrl.protocol !== "https:") throw new ActionError("Webhook 必须使用 HTTPS");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const send = dependencies.safeFetch ?? safeFetch;
      const response = await send(safeUrl.toString(), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: message } }),
        signal: controller.signal
      });
      if (!response.ok) resultCode = `HTTP_${response.status}`;
      else {
        const payload = await response.json().catch(() => null) as { errcode?: unknown } | null;
        if (payload?.errcode === 0) { ok = true; resultCode = "OK"; }
        else resultCode = "REMOTE_REJECTED";
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    resultCode = "NETWORK_ERROR";
  }

  try {
    await auditStrict({
      userId: actor.id,
      action: "FINANCE_WECOM_SEND_RESULT",
      targetType: "FinanceWecomNotification",
      detail: { period: input.period, groupLabel: settings.groupLabel, resultCode }
    });
  } catch {
    console.error("[finance-wecom/send] 发送结果审计失败（详细信息已省略）");
  }
  return { ok, groupLabel: settings.groupLabel, receipt: ok ? "已发送" : "发送失败" };
}
