"use client";

import { useState } from "react";
import { Bell, Eye, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";

type WecomSettingsDto = { enabled: boolean; groupLabel: string; hasWebhook: boolean };
type PreviewDto = { groupLabel: string; enabled: boolean; hasWebhook: boolean; message: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "请求失败");
  return body as Record<string, unknown>;
}

export function FinanceWecomWorkspace({ initialSettings, canManage }: { initialSettings: WecomSettingsDto; canManage: boolean }) {
  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [groupLabel, setGroupLabel] = useState(initialSettings.groupLabel);
  const [hasWebhook, setHasWebhook] = useState(initialSettings.hasWebhook);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [period, setPeriod] = useState("");
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState<"save" | "preview" | "send" | null>(null);

  function clearPreview() {
    setPreview(null);
    setConfirmed(false);
    setReceipt("");
  }

  async function saveSettings() {
    setBusy("save");
    clearPreview();
    try {
      const payload = { enabled, groupLabel, ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}) };
      const result = await readJson(await fetch("/api/finance/internal/wecom/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      })) as unknown as WecomSettingsDto;
      setEnabled(result.enabled);
      setGroupLabel(result.groupLabel);
      setHasWebhook(result.hasWebhook);
      setWebhookUrl("");
      setSettingsDirty(false);
      toast.success("财务企微设置已保存；Webhook 不会回显");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function createPreview() {
    if (!period) {
      toast.error("请先选择月结期间");
      return;
    }
    setBusy("preview");
    clearPreview();
    try {
      const result = await readJson(await fetch("/api/finance/internal/wecom/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period })
      })) as unknown as PreviewDto;
      setPreview(result);
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function sendPreview() {
    if (!preview || !confirmed || settingsDirty || !enabled || !hasWebhook) return;
    setBusy("send");
    setReceipt("");
    try {
      const result = await readJson(await fetch("/api/finance/internal/wecom/send", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period, confirmed: true })
      }));
      const ok = result.ok === true;
      setReceipt(ok ? "已提交发送，企微返回成功。" : "发送未成功；未自动重试。请重新预览并确认后再操作。");
      setConfirmed(false);
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (!canManage) return <div className="mo-note"><Bell className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t-muted)]" aria-hidden="true" /><span>当前账号没有财务通知管理权限。</span></div>;

  const canSend = Boolean(preview && confirmed && enabled && hasWebhook && !settingsDirty && busy === null);
  return <div className="space-y-4">
    <Panel title="财务群通知设置" icon={Bell} extra={enabled && hasWebhook ? <Tag tone="green">已配置并启用</Tag> : <Tag tone="slate">默认关闭</Tag>}>
      <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
        <label className="flex items-center gap-2 self-end pb-2 text-[12px] text-[var(--t-secondary)]"><input aria-label="启用财务企微摘要通知" type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setSettingsDirty(true); clearPreview(); }} /><span>启用财务通知</span></label>
        <label className="block space-y-1.5 text-[12px] text-[var(--t-secondary)]"><span>目标群标签</span><Input aria-label="目标群标签" maxLength={60} value={groupLabel} onChange={(event) => { setGroupLabel(event.target.value); setSettingsDirty(true); clearPreview(); }} placeholder="例如：财务内部群" /></label>
        <label className="block space-y-1.5 text-[12px] text-[var(--t-secondary)] md:col-span-2"><span>企微 Webhook 地址</span><Input aria-label="企微 Webhook 地址" type="password" autoComplete="new-password" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.target.value); setSettingsDirty(true); clearPreview(); }} placeholder={hasWebhook ? "已加密保存；留空表示保持现有地址" : "仅支持 HTTPS；保存后不会再次显示"} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="secondary" onClick={() => void saveSettings()} disabled={busy !== null}><Save aria-hidden="true" />{busy === "save" ? "保存中…" : "保存设置"}</Button><span className="text-[11px] text-[var(--t-muted)]">Webhook 单独加密保存；关闭通知不会删除已保存地址。</span></div>
    </Panel>

    <Panel title="摘要预览与逐次确认" icon={Eye} extra={<Tag tone="amber">不会自动发送</Tag>}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-[180px] space-y-1.5 text-[12px] text-[var(--t-secondary)]"><span>月结期间</span><Input aria-label="月结期间" type="month" value={period} onChange={(event) => { setPeriod(event.target.value); clearPreview(); }} /></label>
        <Button type="button" variant="secondary" onClick={() => void createPreview()} disabled={!period || busy !== null}><Eye aria-hidden="true" />{busy === "preview" ? "生成中…" : "生成预览"}</Button>
        {preview ? <Tag tone={preview.enabled && preview.hasWebhook ? "green" : "slate"}>{preview.groupLabel || "未指定目标群"}</Tag> : null}
      </div>
      {preview ? <div className="mt-3 space-y-3">
        <pre className="whitespace-pre-wrap rounded-[8px] border border-[var(--bd-hair)] bg-[var(--bg-sunken)] p-3 font-sans text-[12px] leading-relaxed">{preview.message}</pre>
        <label className="flex items-start gap-2 text-[12px] text-[var(--t-secondary)]"><input className="mt-0.5" aria-label="我已核对以上内容，并确认发送到所示群聊" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!preview.enabled || !preview.hasWebhook || settingsDirty || busy !== null} /><span>我已核对以上内容，并确认发送到所示群聊。</span></label>
        <div className="flex flex-wrap items-center gap-3"><Button type="button" onClick={() => void sendPreview()} disabled={!canSend}><Send aria-hidden="true" />{busy === "send" ? "发送中…" : "发送到目标群"}</Button>{receipt ? <span role="status" className="text-[12px] text-[var(--t-secondary)]">{receipt}</span> : null}</div>
      </div> : <p className="mt-3 text-[12px] text-[var(--t-muted)]">选择期间后先生成预览。摘要只包含期间、月结状态、阻断项数量和系统内入口，不包含案件、客户、人员、金额、账号或附件链接。</p>}
    </Panel>
  </div>;
}
