"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, ChevronRight, CircleHelp, Download, Link2Off } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import type { ReconciliationWorkspaceQueue } from "./types";

function money(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `¥${parsed.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : value;
}

function mask(value: string): string {
  return value.length > 8 ? `****${value.slice(-6)}` : value;
}

function statusLabel(value: string): string {
  return ({ UNRESOLVED: "待处理", SUGGESTED: "有建议", SUSPECT: "疑点", EXCEPTION: "例外", CONFIRMED: "已确认", IGNORED: "已忽略" } as Record<string, string>)[value] ?? value;
}

export function ReconciliationWorkspace({ queue, period, canReconcile }: { queue: ReconciliationWorkspaceQueue; period: string; canReconcile: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const unresolved = useMemo(() => queue.items.filter((item) => !["CONFIRMED", "IGNORED"].includes(item.status)), [queue.items]);

  async function decide(caseId: string, decision: "CONFIRM" | "SUSPECT" | "IGNORE" | "REFUND") {
    const paymentId = selected[caseId] ?? queue.items.find((item) => item.id === caseId)?.suggestions[0]?.paymentId;
    const reason = reasons[caseId]?.trim();
    const item = queue.items.find((candidate) => candidate.id === caseId);
    if ((decision === "CONFIRM" || decision === "REFUND") && !paymentId) {
      toast.error(decision === "REFUND" ? "请先选择一笔已登记退款的原付款" : "请先选择一个已确认收款");
      return;
    }
    if (decision !== "CONFIRM" && !reason) {
      toast.error("请填写处理理由");
      return;
    }
    setBusy(`${caseId}-${decision}`);
    try {
      const isRefund = decision === "REFUND";
      const response = await fetch(isRefund ? "/api/finance/internal/refund-links" : `/api/finance/internal/reconciliation/${encodeURIComponent(caseId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isRefund ? {
          sourceRowId: item?.sourceRowId,
          paymentId,
          amount: item?.row.amount.startsWith("-") ? item.row.amount.slice(1) : "",
          reason
        } : { decision, paymentId, reason })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "对账决定提交失败");
      toast.success(isRefund ? "退款已关联并纳入分配复核" : decision === "CONFIRM" ? "已确认归类" : decision === "SUSPECT" ? "已标记疑点" : "已忽略该来源行");
      router.refresh();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="待认领与归类"
      icon={Link2Off}
      count={queue.total}
      extra={<Link className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" href={`/api/finance/internal/reconciliation/export?periodStart=${encodeURIComponent(`${period}-01`)}&periodEnd=${encodeURIComponent(nextMonth(period))}`}><Download className="h-3.5 w-3.5" aria-hidden="true" />导出决定表</Link>}
    >
      {queue.items.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
          <Check className="h-8 w-8 text-[var(--green)]" aria-hidden="true" />
          <div className="mt-3 text-[13px] font-[600]">本期没有待处理来源行</div>
          <div className="mt-1.5 text-[12px] text-[var(--t-muted)]">新的银行流水归档后，会在这里显示匹配建议。</div>
        </div>
      ) : (
        <div className="space-y-3">
          {!canReconcile ? <div className="mo-note"><CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />当前账号可以查看队列，但没有确认、忽略或标记疑点的权限。</div> : null}
          {unresolved.length < queue.items.length ? <div className="text-[11.5px] text-[var(--t-muted)]">已处理记录仍保留在本页，便于回看决定链。</div> : null}
          {queue.items.map((item) => <ReconciliationRow key={item.id} item={item} selected={selected[item.id] ?? item.suggestions[0]?.paymentId ?? ""} reason={reasons[item.id] ?? ""} canReconcile={canReconcile} busy={busy?.startsWith(`${item.id}-`) ?? false} onSelect={(value) => setSelected((current) => ({ ...current, [item.id]: value }))} onReason={(value) => setReasons((current) => ({ ...current, [item.id]: value }))} onDecide={(decision) => void decide(item.id, decision)} />)}
        </div>
      )}
    </Panel>
  );
}

function ReconciliationRow({ item, selected, reason, canReconcile, busy, onSelect, onReason, onDecide }: { item: ReconciliationWorkspaceQueue["items"][number]; selected: string; reason: string; canReconcile: boolean; busy: boolean; onSelect: (value: string) => void; onReason: (value: string) => void; onDecide: (decision: "CONFIRM" | "SUSPECT" | "IGNORE" | "REFUND") => void }) {
  return (
    <article className="rounded-[10px] border border-[var(--bd-hair)] bg-card p-3.5 transition-colors hover:border-[var(--bd-default)]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--amber-bg)] text-[var(--amber)]"><AlertTriangle className="h-4 w-4" aria-hidden="true" /></div>
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[11px] text-[var(--t-muted)]">来源 {mask(item.row.sourceBatchId ?? "未知批次")} · 第 {item.row.sourceRowNumber} 行</span><Tag tone={item.status === "SUGGESTED" ? "amber" : item.status === "CONFIRMED" ? "green" : item.status === "IGNORED" ? "slate" : "red"}>{statusLabel(item.status)}</Tag></div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong className="font-mono text-[17px] tracking-tight">{money(item.row.amount)}</strong><span className="text-[12px] text-[var(--t-muted)]">{item.row.occurredAt} · {item.row.direction === "CREDIT" ? "收入" : item.row.direction === "DEBIT" ? "支出" : "方向待核"}</span></div>
          <div className="mt-1 text-[12px] text-[var(--t-secondary)]">{item.row.counterparty || "未记录对方"}{item.row.description ? ` · ${item.row.description}` : ""}</div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-[var(--t-muted)]"><div>匹配候选 {item.suggestions.length} 个</div><div className="mt-1">账户 {item.row.accountMasked || "未记录"}</div></div>
      </div>
      {item.suggestions.length > 0 ? (
        <div className="mt-3 rounded-[8px] bg-[var(--bg-sunken)] p-3">
          <div className="mb-2 text-[11.5px] font-[600] text-[var(--t-secondary)]">{item.row.direction === "DEBIT" ? "可关联的已登记退款" : "系统建议"}</div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_150px] md:items-center">
            <select aria-label={`选择来源行 ${item.row.sourceRowNumber} 的目标`} className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2 text-[12px]" value={selected} onChange={(event) => onSelect(event.target.value)} disabled={!canReconcile || busy}>
              {item.suggestions.map((suggestion) => <option key={suggestion.paymentId} value={suggestion.paymentId}>{mask(suggestion.paymentId)} · {suggestion.score} 分 · {suggestion.reason}{suggestion.candidateSummary ? ` · ${suggestion.candidateSummary}` : ""}</option>)}
            </select>
            <div className="flex items-center justify-end gap-1.5 text-[11px] text-[var(--t-muted)]"><span className="font-mono">候选得分</span><strong className="text-[var(--teal-deep)]">{item.suggestions[0].score}</strong><ChevronRight className="h-3 w-3" aria-hidden="true" /></div>
          </div>
        </div>
      ) : <div className="mt-3 rounded-[8px] bg-[var(--bg-sunken)] px-3 py-2.5 text-[11.5px] text-[var(--t-muted)]">{item.row.direction === "DEBIT" ? "没有金额足够且尚未关联的已登记退款余额；请先核对原付款的退款冲销记录。" : "暂未找到可自动建议的已确认律师费收款，需要人工核对来源。"}</div>}
      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label className="block space-y-1 text-[11px] text-[var(--t-muted)]"><span>{item.row.direction === "DEBIT" ? "退款关联说明（必填）" : "疑点或忽略理由（标记疑点、忽略时必填）"}</span><Input aria-label={`来源行 ${item.row.sourceRowNumber} 的处理理由`} value={reason} onChange={(event) => onReason(event.target.value)} disabled={!canReconcile || busy} placeholder={item.row.direction === "DEBIT" ? "说明该银行退款对应的原收款" : "例如：需与合同收款人进一步核对"} /></label>
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.row.direction === "DEBIT"
            ? <Button type="button" size="sm" disabled={!canReconcile || busy || !item.suggestions.length || item.status === "CONFIRMED"} onClick={() => onDecide("REFUND")}>关联退款</Button>
            : <Button type="button" size="sm" disabled={!canReconcile || busy || !item.suggestions.length || item.status === "CONFIRMED"} onClick={() => onDecide("CONFIRM")}><Check aria-hidden="true" />接受建议</Button>}
          <Button type="button" size="sm" variant="danger" disabled={!canReconcile || busy || item.status === "SUSPECT"} onClick={() => onDecide("SUSPECT")}>标记疑点</Button>
          <Button type="button" size="sm" variant="ghost" disabled={!canReconcile || busy || item.status === "IGNORED"} onClick={() => onDecide("IGNORE")}>忽略并说明</Button>
        </div>
      </div>
    </article>
  );
}

function nextMonth(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
}
