"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Ban, Download, FileCheck2, Fingerprint, Plus, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import type { MonthlyCloseWorkspaceData } from "./types";

export function MonthlyCloseWorkspace({ data, canMaterialize, canAdjust }: { data: MonthlyCloseWorkspaceData; canMaterialize: boolean; canAdjust: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ account: "", targetUserId: "", amount: "", reason: "" });
  const status = data.status;

  async function postJson(url: string, body: unknown, success: string, key: string): Promise<boolean> {
    setBusy(key);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "操作失败");
      toast.success(success);
      router.refresh();
      return true;
    } catch (error) {
      toast.error(actionErrorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createAdjustment() {
    const saved = await postJson("/api/finance/internal/adjustments", { period: data.period, account: adjustment.account, targetUserId: adjustment.targetUserId || null, amount: adjustment.amount, reason: adjustment.reason }, "调整凭证已追加", "adjust");
    if (saved) setAdjustment({ account: "", targetUserId: "", amount: "", reason: "" });
  }

  async function reverse(id: string) {
    await postJson(`/api/finance/internal/adjustments/${encodeURIComponent(id)}/reverse`, { note: "月结核对后追加冲销" }, "冲销凭证已追加", `reverse-${id}`);
  }

  return (
    <div className="space-y-4">
      <Panel title={`${data.period} 月结闸门`} icon={FileCheck2} extra={<Tag tone={status.ready ? "green" : "amber"} dot>{status.ready ? "可以生成交付" : "存在待处理项"}</Tag>}>
        <div className="grid gap-2 sm:grid-cols-4"><CloseMetric label="来源文件" value={`${status.sourceFiles} 个`} /><CloseMetric label="来源行" value={`${status.transactionCount} 行`} /><CloseMetric label="待认领" value={`${status.unresolvedCount} 条`} tone={status.unresolvedCount ? "amber" : "green"} /><CloseMetric label="分配批次" value={status.runId ? "已提交" : "未生成"} tone={status.runId ? "green" : "amber"} /></div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="rounded-[10px] border border-[var(--bd-hair)] p-3.5"><div className="flex items-center gap-2 text-[12px] font-[600]"><Fingerprint className="h-4 w-4 text-[var(--teal)]" aria-hidden="true" />本期来源指纹</div><div className="mt-2 break-all font-mono text-[11px] text-[var(--t-muted)]">{status.sourceHash ? `${status.sourceHash.slice(0, 18)}…${status.sourceHash.slice(-8)}` : "尚未生成"}</div>{status.runId ? <div className="mt-1.5 text-[11px] text-[var(--t-faint)]">计算批次：{status.runId.length > 8 ? `****${status.runId.slice(-6)}` : status.runId}</div> : null}</div>
          <div className="flex flex-wrap content-start gap-2 lg:justify-end">{canMaterialize ? <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void postJson("/api/finance/internal/materialize", { period: data.period }, "正式计算批次已生成", "materialize")}><RefreshCw aria-hidden="true" />{busy === "materialize" ? "生成中…" : "生成正式批次"}</Button> : null}<Button type="button" variant="approve" disabled={!status.ready || busy !== null} onClick={() => void postJson("/api/finance/internal/monthly-close", { period: data.period }, "月结交付包已生成", "close")}><Archive aria-hidden="true" />{busy === "close" ? "生成中…" : "生成月结交付包"}</Button></div>
        </div>
        {status.blockingWarnings.length > 0 ? <WarningList title="阻断项" tone="red" items={status.blockingWarnings} /> : null}
        {status.reviewWarnings.length > 0 ? <WarningList title="复核提示" tone="amber" items={status.reviewWarnings} /> : null}
      </Panel>

      <Panel title="月结交付文件" icon={Download}>
        {data.artifacts.length === 0 ? <div className="mo-note"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--amber)]" aria-hidden="true" />正式月结包生成后，工资、会计资料、个人内账、调整审计和完整 ZIP 会出现在这里。</div> : <div className="grid gap-2 md:grid-cols-2">{data.artifacts.map((artifact) => <a key={artifact.id} href={`/api/finance/internal/artifacts/${encodeURIComponent(artifact.id)}`} className="flex items-center gap-3 rounded-[8px] border border-[var(--bd-hair)] px-3 py-2.5 no-underline transition-colors hover:border-[var(--teal-line)] hover:bg-[var(--teal-soft)]"><FileCheck2 className="h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-[550]">{artifact.fileName}</span><span className="mt-0.5 block text-[10.5px] text-[var(--t-muted)]">{artifact.kind} · {formatBytes(artifact.byteSize)} · {artifact.sha256.slice(0, 12)}…</span></span><Download className="h-3.5 w-3.5 text-[var(--t-muted)]" aria-hidden="true" /></a>)}</div>}
      </Panel>

      <Panel title="追加调整与冲销" icon={RotateCcw} extra={<Tag tone="slate">原始记录保留</Tag>}>
        {canAdjust ? <div className="rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5"><div className="grid gap-3 md:grid-cols-3"><label className="block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>科目</span><Input value={adjustment.account} onChange={(event) => setAdjustment((current) => ({ ...current, account: event.target.value }))} placeholder="例如：user.self_cost" /></label><label className="block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>目标人员 ID（可空）</span><Input value={adjustment.targetUserId} onChange={(event) => setAdjustment((current) => ({ ...current, targetUserId: event.target.value }))} placeholder="内部 ID" /></label><label className="block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>金额</span><Input inputMode="decimal" value={adjustment.amount} onChange={(event) => setAdjustment((current) => ({ ...current, amount: event.target.value }))} placeholder="100.00" /></label></div><label className="mt-3 block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>调整理由</span><Textarea value={adjustment.reason} onChange={(event) => setAdjustment((current) => ({ ...current, reason: event.target.value }))} placeholder="说明依据和影响范围" /></label><div className="mt-3 flex justify-end"><Button type="button" size="sm" disabled={busy !== null || !adjustment.account || !adjustment.amount || !adjustment.reason} onClick={() => void createAdjustment()}><Plus aria-hidden="true" />{busy === "adjust" ? "追加中…" : "追加调整凭证"}</Button></div></div> : <div className="mo-note"><Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />当前账号没有维护调整的权限；已有调整仍可查看。</div>}
        {data.adjustments.length === 0 ? <div className="mt-4 text-[12px] text-[var(--t-muted)]">本期还没有追加调整。</div> : <div className="mt-4 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)]"><table className="mo-table min-w-[680px] text-[11.5px]"><thead><tr><th>科目</th><th className="text-right">金额</th><th>状态</th><th>理由</th><th>操作</th></tr></thead><tbody>{data.adjustments.map((item) => <tr key={item.id}><td className="font-mono">{item.account}</td><td className="text-right font-mono">{item.amount}</td><td><Tag tone={item.status === "REVERSED" ? "slate" : "green"}>{item.status === "REVERSED" ? "已冲销" : "已入账"}</Tag></td><td className="max-w-[280px] truncate">{item.reason}</td><td>{canAdjust && item.status !== "REVERSED" && !item.reversalOfId ? <Button type="button" size="sm" variant="danger" disabled={busy !== null} onClick={() => void reverse(item.id)}>{busy === `reverse-${item.id}` ? "冲销中…" : "追加冲销"}</Button> : <span className="text-[11px] text-[var(--t-faint)]">—</span>}</td></tr>)}</tbody></table></div>}
      </Panel>
    </div>
  );
}

function CloseMetric({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "amber" | "green" }) {
  return <div className="rounded-[8px] bg-[var(--bg-sunken)] px-3 py-2.5"><div className="text-[11px] text-[var(--t-muted)]">{label}</div><div className={tone === "green" ? "mt-1 text-[15px] font-[650] text-[var(--green)]" : tone === "amber" ? "mt-1 text-[15px] font-[650] text-[var(--amber)]" : "mt-1 text-[15px] font-[650]"}>{value}</div></div>;
}

function WarningList({ title, items, tone }: { title: string; items: string[]; tone: "red" | "amber" }) {
  return <div className={tone === "red" ? "mt-4 rounded-[8px] border border-[var(--red-line)] bg-[var(--red-bg)] p-3 text-[12px] text-[var(--red)]" : "mt-4 rounded-[8px] border border-[var(--amber-line)] bg-[var(--amber-bg)] p-3 text-[12px] text-[var(--amber-deep)]"}><div className="font-[600]">{title}</div><ul className="mt-1.5 list-disc space-y-1 pl-4">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
