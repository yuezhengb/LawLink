"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenCheck, CalendarClock, LockKeyhole, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import type { InternalRuleSet } from "./types";

const initialForm = { name: "", kind: "CHANNEL", effectiveFrom: "2026-01-01", effectiveTo: "", channelRate: "0.10", firmRate: "0.45", sourceRate: "0.20", handlingRate: "0.25", coRate: "0.10", sourceNote: "" };

export function RulesWorkspace({ ruleSets, canManageRules }: { ruleSets: InternalRuleSet[]; canManageRules: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState(initialForm);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function createDraft() {
    setBusy("create");
    try {
      const response = await fetch("/api/finance/internal/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, definition: { kind: form.kind, effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null, percentages: { channelRate: form.channelRate, firmRate: form.firmRate, sourceRate: form.sourceRate, handlingRate: form.handlingRate, coRate: form.coRate }, roundingMode: "HALF_UP", sourceNote: form.sourceNote } }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "规则草稿保存失败");
      toast.success("规则草稿已保存");
      setForm(initialForm);
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function publish(id: string) {
    setBusy(id);
    try {
      const response = await fetch(`/api/finance/internal/rules/${encodeURIComponent(id)}/publish`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "规则发布失败");
      toast.success("规则已发布，新版本不可直接修改");
      router.refresh();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="内部核算规则" icon={BookOpenCheck} extra={canManageRules ? <Button size="sm" onClick={() => setOpen((value) => !value)}><Plus aria-hidden="true" />新增草稿</Button> : <Tag tone="slate">只读</Tag>}>
        {open ? <RuleDraftForm form={form} busy={busy === "create"} onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))} onCancel={() => setOpen(false)} onSave={() => void createDraft()} /> : null}
        {!open && ruleSets.length === 0 ? <div className="mo-note"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />还没有规则集。先建立一份草稿，确认生效日期与比例后再发布。</div> : null}
        {ruleSets.length > 0 ? <div className="mt-4 space-y-3">{ruleSets.map((ruleSet) => <RuleSetCard key={ruleSet.id} ruleSet={ruleSet} canManageRules={canManageRules} busy={busy} onPublish={(id) => void publish(id)} />)}</div> : null}
      </Panel>
      <Panel title="规则边界" icon={LockKeyhole}>
        <div className="grid gap-3 text-[12px] text-[var(--t-secondary)] md:grid-cols-3"><div className="rounded-[8px] bg-[var(--bg-sunken)] p-3">已发布版本不可修改或删除，只能通过新版本调整。</div><div className="rounded-[8px] bg-[var(--bg-sunken)] p-3">同一规则集的生效日期不能重叠，保存时会阻断。</div><div className="rounded-[8px] bg-[var(--bg-sunken)] p-3">页面只展示规则与比例，不展示未掩码的银行来源证据。</div></div>
      </Panel>
    </div>
  );
}

type Form = typeof initialForm;
function RuleDraftForm({ form, busy, onChange, onCancel, onSave }: { form: Form; busy: boolean; onChange: (key: keyof Form, value: string) => void; onCancel: () => void; onSave: () => void }) {
  const fields: Array<[keyof Form, string, string]> = [["name", "规则名称", "例如：渠道案基础分成"], ["kind", "规则类型", "例如：CHANNEL"], ["effectiveFrom", "生效日", ""], ["effectiveTo", "结束日（可空）", ""], ["channelRate", "渠道比例", "0.10"], ["firmRate", "律所比例", "0.45"], ["sourceRate", "案源比例", "0.20"], ["handlingRate", "承办比例", "0.25"], ["coRate", "协办比例", "0.10"]];
  return <div className="mb-4 rounded-[10px] border border-[var(--teal-line)] bg-[var(--teal-soft)] p-3.5"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([key, label, placeholder]) => <label key={key} className="block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>{label}</span><Input type={key === "effectiveFrom" || key === "effectiveTo" ? "date" : "text"} value={form[key]} placeholder={placeholder} onChange={(event) => onChange(key, event.target.value)} /></label>)}</div><label className="mt-3 block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>规则来源说明</span><Textarea value={form.sourceNote} onChange={(event) => onChange("sourceNote", event.target.value)} placeholder="写清这版比例依据的内部约定或会议纪要" /></label><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-[var(--t-muted)]">比例使用小数填写：0.10 表示 10%；保存后仍需单独发布。</span><div className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button><Button type="button" size="sm" disabled={busy} onClick={onSave}>{busy ? "保存中…" : "保存草稿"}</Button></div></div></div>;
}

function RuleSetCard({ ruleSet, canManageRules, busy, onPublish }: { ruleSet: InternalRuleSet; canManageRules: boolean; busy: string | null; onPublish: (id: string) => void }) {
  return <div className="rounded-[10px] border border-[var(--bd-hair)] p-3.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-[13px] font-[600]">{ruleSet.name}</div><div className="mt-0.5 text-[11px] text-[var(--t-muted)]">{ruleSet.kind} · {ruleSet.versions.length} 个版本</div></div><Tag tone="slate">版本化规则</Tag></div><div className="mt-3 space-y-2">{ruleSet.versions.map((version) => <div key={version.id} className="flex flex-wrap items-center gap-3 rounded-[8px] bg-[var(--bg-sunken)] px-3 py-2.5"><div className="font-mono text-[11px] text-[var(--t-secondary)]">v{version.version}</div><div className="min-w-[170px] flex-1 text-[11.5px] text-[var(--t-muted)]">{version.effectiveFrom.slice(0, 10)} 至 {version.effectiveTo?.slice(0, 10) ?? "未设结束"}</div><Tag tone={version.publishedAt ? "green" : "amber"} dot>{version.publishedAt ? "已发布" : "草稿"}</Tag>{version.publishedAt ? <span className="text-[11px] text-[var(--t-faint)]">不可修改</span> : canManageRules ? <Button type="button" size="sm" variant="approve" disabled={busy !== null} onClick={() => onPublish(version.id)}><Send aria-hidden="true" />{busy === version.id ? "发布中…" : "发布"}</Button> : null}</div>)}</div></div>;
}
