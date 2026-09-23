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
import type { FinancePeriodCoverageInput } from "@/lib/finance/internal-types";
import type { MonthlyCloseWorkspaceData } from "./types";

type AllocationPreviewState = {
  runId: string;
  sourceHash: string;
  status: "PREVIEW" | "COMMITTED";
  allocationVersion: 2;
  blockingIssues: string[];
  lines: Array<{ grossAmount: string }>;
  recipients: Array<{ userId: string; amount: string }>;
};

export function MonthlyCloseWorkspace({ data, canMaterialize, canAdjust, canExport }: { data: MonthlyCloseWorkspaceData; canMaterialize: boolean; canAdjust: boolean; canExport: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ account: "", targetUserId: "", amount: "", reason: "" });
  const [allocationPreview, setAllocationPreview] = useState<AllocationPreviewState | null>(null);
  const [bankCoverageText, setBankCoverageText] = useState(() => data.coverageDetails?.bankAccounts.map((account) => `${account.alias} | ${account.batchIds.join(",")} | ${account.noTransactionsReason ?? ""}`).join("\n") ?? data.sourceBatches.filter((batch) => batch.kind === "BANK_STATEMENT").map((batch, index) => `账户别名待填写${index + 1} | ${batch.id} |`).join("\n"));
  const [payrollBatchIds, setPayrollBatchIds] = useState(() => data.coverageDetails?.payrollBatchIds.join(",") ?? "");
  const [rosterBatchIds, setRosterBatchIds] = useState(() => data.coverageDetails?.rosterBatchIds.join(",") ?? "");
  const [externalBatchIds, setExternalBatchIds] = useState(() => data.coverageDetails?.externalBatchIds.join(",") ?? "");
  const [coverageReasons, setCoverageReasons] = useState(() => ({
    payroll: data.coverageDetails?.noPayrollReason ?? "",
    roster: data.coverageDetails?.noRosterReason ?? "",
    external: data.coverageDetails?.noExternalReason ?? ""
  }));
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

  async function saveCoverage() {
    const bankAccounts = bankCoverageText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [alias = "", ids = "", noTransactionsReason = ""] = line.split("|");
      return { alias: alias.trim(), batchIds: splitIds(ids), ...(noTransactionsReason.trim() ? { noTransactionsReason: noTransactionsReason.trim() } : {}) };
    });
    const details: FinancePeriodCoverageInput = {
      bankAccounts,
      payrollBatchIds: splitIds(payrollBatchIds),
      ...(coverageReasons.payroll.trim() ? { noPayrollReason: coverageReasons.payroll.trim() } : {}),
      rosterBatchIds: splitIds(rosterBatchIds),
      ...(coverageReasons.roster.trim() ? { noRosterReason: coverageReasons.roster.trim() } : {}),
      externalBatchIds: splitIds(externalBatchIds),
      ...(coverageReasons.external.trim() ? { noExternalReason: coverageReasons.external.trim() } : {})
    };
    await postJson("/api/finance/internal/coverage", { period: data.period, details }, "本期来源覆盖已确认", "coverage");
  }

  async function previewAllocation() {
    setBusy("preview");
    try {
      const response = await fetch("/api/finance/internal/materialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period: data.period }) });
      const result = await response.json().catch(() => ({})) as Partial<AllocationPreviewState> & { error?: string };
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "分配预览失败");
      if (typeof result.runId !== "string" || !Array.isArray(result.blockingIssues) || !Array.isArray(result.lines) || !Array.isArray(result.recipients) || (result.status !== "PREVIEW" && result.status !== "COMMITTED")) {
        throw new Error("服务器返回的预览信息不完整，请刷新页面后重试");
      }
      setAllocationPreview(result as AllocationPreviewState);
      toast.success(result.blockingIssues.length ? `预览已生成，存在 ${result.blockingIssues.length} 项阻断` : "分配预览已生成，请核对明细");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function commitAllocationPreview() {
    if (!allocationPreview || allocationPreview.status !== "PREVIEW" || allocationPreview.blockingIssues.length > 0) return;
    const committed = await postJson("/api/finance/internal/allocation/commit", { runId: allocationPreview.runId }, "正式分配已提交", "commit-allocation");
    if (committed) setAllocationPreview(null);
  }

  return (
    <div className="space-y-4">
      <Panel title={`${data.period} 月结闸门`} icon={FileCheck2} extra={<Tag tone={status.ready ? "green" : "amber"} dot>{status.ready ? "可以生成交付" : "存在待处理项"}</Tag>}>
        <div className="grid gap-2 sm:grid-cols-4"><CloseMetric label="来源文件" value={`${status.sourceFiles} 个`} /><CloseMetric label="来源行" value={`${status.transactionCount} 行`} /><CloseMetric label="待认领" value={`${status.unresolvedCount} 条`} tone={status.unresolvedCount ? "amber" : "green"} /><CloseMetric label="分配批次" value={status.runId ? "已提交" : "未生成"} tone={status.runId ? "green" : "amber"} /></div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="rounded-[10px] border border-[var(--bd-hair)] p-3.5"><div className="flex items-center gap-2 text-[12px] font-[600]"><Fingerprint className="h-4 w-4 text-[var(--teal)]" aria-hidden="true" />本期来源指纹</div><div className="mt-2 break-all font-mono text-[11px] text-[var(--t-muted)]">{status.sourceHash ? `${status.sourceHash.slice(0, 18)}…${status.sourceHash.slice(-8)}` : "尚未生成"}</div>{status.runId ? <div className="mt-1.5 text-[11px] text-[var(--t-faint)]">计算批次：{status.runId.length > 8 ? `****${status.runId.slice(-6)}` : status.runId}</div> : null}</div>
          <div className="flex flex-wrap content-start gap-2 lg:justify-end">{canMaterialize ? <><Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void previewAllocation()}><RefreshCw aria-hidden="true" />{busy === "preview" ? "计算中…" : "预览本期分配"}</Button><Button type="button" variant="approve" disabled={!allocationPreview || allocationPreview.status !== "PREVIEW" || allocationPreview.blockingIssues.length > 0 || busy !== null} onClick={() => void commitAllocationPreview()}><FileCheck2 aria-hidden="true" />{busy === "commit-allocation" ? "提交中…" : allocationPreview?.status === "COMMITTED" ? "批次已提交" : "确认正式分配"}</Button></> : null}{canExport ? <Button type="button" variant="approve" disabled={!status.ready || busy !== null} onClick={() => void postJson("/api/finance/internal/monthly-close", { period: data.period }, "月结交付包已生成", "close")}><Archive aria-hidden="true" />{busy === "close" ? "生成中…" : "生成月结交付包"}</Button> : null}</div>
        </div>
        {allocationPreview ? <div aria-live="polite" className="mt-4 rounded-[10px] border border-[var(--teal-line)] bg-[var(--teal-soft)] p-3.5"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-[12px] font-[600]">{allocationPreview.status === "COMMITTED" ? "已提交分配批次" : "待核对分配预览"} · {allocationPreview.lines.length} 条总额行 · {allocationPreview.recipients.length} 条人员分配</div><div className="font-mono text-[10.5px] text-[var(--t-muted)]">版本 2 · {allocationPreview.runId.length > 8 ? `****${allocationPreview.runId.slice(-6)}` : allocationPreview.runId}</div></div>{allocationPreview.blockingIssues.length > 0 ? <WarningList title="请先处理以下阻断项" tone="red" items={allocationPreview.blockingIssues} /> : <div className="mt-2 text-[11.5px] text-[var(--t-secondary)]">来源指纹：<span className="font-mono">{allocationPreview.sourceHash.slice(0, 16)}…</span>。核对无误后再确认正式分配；提交时系统会重新读取来源并校验金额。</div>}</div> : null}
        {status.blockingWarnings.length > 0 ? <WarningList title="阻断项" tone="red" items={status.blockingWarnings} /> : null}
        {status.reviewWarnings.length > 0 ? <WarningList title="复核提示" tone="amber" items={status.reviewWarnings} /> : null}
      </Panel>

      <Panel title="本期来源覆盖确认" icon={Fingerprint} extra={<Tag tone={status.coverageConfirmed ? "green" : "amber"} dot>{status.coverageConfirmed ? "已确认" : "待确认"}</Tag>}>
        <p className="text-[12px] leading-relaxed text-[var(--t-secondary)]">逐一确认本所银行账户别名与流水批次；工资表、花名册须选择资料批次或写明无资料原因。外部三表未取得时填写原因，系统会保留复核提示。</p>
        <div className="mt-3 rounded-[8px] border border-[var(--bd-hair)] bg-[var(--bg-sunken)] p-3">
          <div className="text-[11.5px] font-[600] text-[var(--t-secondary)]">本期已归档来源批次（可复制编号）</div>
          {data.sourceBatches.length ? <div className="mt-2 space-y-1.5">{data.sourceBatches.map((batch) => <div key={batch.id} className="grid gap-1 text-[11px] sm:grid-cols-[150px_minmax(0,1fr)_90px]"><span>{batch.kind} · {batch.rowCount} 行</span><span className="truncate">{batch.fileName}</span><code className="select-all text-[var(--t-muted)]">{batch.id}</code></div>)}</div> : <div className="mt-2 text-[11px] text-[var(--t-muted)]">本期尚无已归档来源。若确无流水/工资/名册，请在下方说明。</div>}
        </div>
        {canAdjust ? <div className="mt-3 space-y-3">
          <label className="block space-y-1.5 text-[11.5px] font-[550] text-[var(--t-secondary)]"><span>银行账户覆盖（每行：账户别名 | 批次编号,批次编号 | 无流水原因）</span><Textarea aria-label="银行账户覆盖" value={bankCoverageText} onChange={(event) => setBankCoverageText(event.target.value)} placeholder="基本户 | batch-id-1,batch-id-2 |" /></label>
          <div className="grid gap-3 md:grid-cols-3">
            <CoverageField label="工资批次编号（逗号分隔）" value={payrollBatchIds} onChange={setPayrollBatchIds} reasonLabel="无工资资料原因" reason={coverageReasons.payroll} onReasonChange={(value) => setCoverageReasons((current) => ({ ...current, payroll: value }))} />
            <CoverageField label="花名册批次编号（逗号分隔）" value={rosterBatchIds} onChange={setRosterBatchIds} reasonLabel="无需更新/无花名册原因" reason={coverageReasons.roster} onReasonChange={(value) => setCoverageReasons((current) => ({ ...current, roster: value }))} />
            <CoverageField label="外部三表批次编号（逗号分隔）" value={externalBatchIds} onChange={setExternalBatchIds} reasonLabel="尚未取得三表的原因" reason={coverageReasons.external} onReasonChange={(value) => setCoverageReasons((current) => ({ ...current, external: value }))} />
          </div>
          <div className="flex justify-end"><Button type="button" disabled={busy !== null} onClick={() => void saveCoverage()}><FileCheck2 aria-hidden="true" />{busy === "coverage" ? "确认中…" : "保存并确认来源覆盖"}</Button></div>
        </div> : <div className="mt-3 mo-note"><Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />当前账号没有确认来源覆盖的权限。</div>}
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

function CoverageField({ label, value, onChange, reasonLabel, reason, onReasonChange }: { label: string; value: string; onChange: (value: string) => void; reasonLabel: string; reason: string; onReasonChange: (value: string) => void }) {
  return <div className="space-y-2"><label className="block space-y-1.5 text-[11px] font-[550] text-[var(--t-secondary)]"><span>{label}</span><Input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} /></label><label className="block space-y-1.5 text-[11px] font-[550] text-[var(--t-secondary)]"><span>{reasonLabel}</span><Input aria-label={reasonLabel} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></label></div>;
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
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
