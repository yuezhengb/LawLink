"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CheckCircle2, Eye, FileSpreadsheet, UploadCloud, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import type { FinanceImportPreview, FinanceRowError, FinanceNormalizedRow } from "@/lib/finance/internal-types";
import type { FinanceImportReviewRow } from "@/server/finance/internal-import-review";
import type { InternalImportBatch } from "./types";

const KIND_OPTIONS = [
  ["BANK_STATEMENT", "银行流水"],
  ["PAYROLL", "工资表"],
  ["ROSTER", "花名册"],
  ["EXTERNAL_THREE_STATEMENTS", "外账三表"],
  ["OTHER", "其他财务资料"]
] as const;

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find(([value]) => value === kind)?.[1] ?? kind;
}

function shortDate(value: string | null): string {
  if (!value) return "未标期间";
  return value.slice(0, 10);
}

function maskId(value: string): string {
  return value.length > 8 ? `****${value.slice(-6)}` : value;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "请求失败");
  return body as Record<string, unknown>;
}

export function ImportWorkspace({ batches, reviewRecords, reviewUsers, canImport, canReview }: {
  batches: InternalImportBatch[];
  reviewRecords: FinanceImportReviewRow[];
  reviewUsers: Array<{ id: string; name: string; role: string }>;
  canImport: boolean;
  canReview: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState("BANK_STATEMENT");
  const [period, setPeriod] = useState("");
  const [asOfDay, setAsOfDay] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FinanceImportPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);

  async function previewUpload() {
    if (!file) {
      toast.error("请先选择 CSV 或 XLSX 文件");
      return;
    }
    setBusy("preview");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      if (period) form.append("period", period);
      if (asOfDay) form.append("asOfDay", asOfDay);
      const result = await readJson(await fetch("/api/finance/internal/imports/preview", { method: "POST", body: form }));
      setPreview(result as unknown as FinanceImportPreview);
      toast.success("预览完成，请核对行数和错误");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function commitUpload() {
    if (!file || !preview) return;
    setBusy("commit");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      if (period) form.append("period", period);
      if (asOfDay) form.append("asOfDay", asOfDay);
      const result = await readJson(await fetch("/api/finance/internal/imports/commit", { method: "POST", body: form }));
      toast.success(result.duplicate ? "该文件已经归档，未重复写入" : "财务资料已归档");
      setPreview(null);
      setFile(null);
      window.location.reload();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="导入并归档"
        icon={UploadCloud}
        extra={canImport ? <Tag tone="teal" dot>可操作</Tag> : <Tag tone="slate">只读</Tag>}
      >
        {canImport ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_180px_auto] md:items-end">
              <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
                <span>资料类型</span>
                <select aria-label="资料类型" className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2.5 text-[13px]" value={kind} onChange={(event) => { setKind(event.target.value); setPreview(null); }}>
                  {KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
                <span>来源文件</span>
                <Input aria-label="来源文件" type="file" accept=".csv,.xlsx,.xls" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} />
              </label>
              {kind === "ROSTER" ? (
                <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
                  <span>花名册截至日期</span>
                  <Input aria-label="花名册截至日期" type="date" value={asOfDay} onChange={(event) => { setAsOfDay(event.target.value); setPreview(null); }} />
                </label>
              ) : kind !== "BANK_STATEMENT" ? (
                <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
                  <span>资料账期</span>
                  <Input aria-label="资料账期" type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setPreview(null); }} />
                </label>
              ) : null}
              <Button type="button" onClick={() => void previewUpload()} disabled={!file || busy !== null}>
                <Eye aria-hidden="true" />{busy === "preview" ? "预览中…" : "上传并预览"}
              </Button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-[var(--t-muted)]">系统只接受 CSV / XLSX；传统 XLS 请先转换。预览不会写入归档，提交前会再次校验文件指纹。</p>
            {preview ? <PreviewBlock preview={preview} busy={busy} onCommit={() => void commitUpload()} /> : null}
          </div>
        ) : (
          <div className="mo-note">
            <Archive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t-muted)]" aria-hidden="true" />
            <span>当前账号可以查看已归档资料，但没有导入权限。需要新增来源时，请联系财务账号处理。</span>
          </div>
        )}
      </Panel>

      <Panel title="已归档来源" icon={FileSpreadsheet} count={batches.length} flush>
        {batches.length === 0 ? (
          <div className="p-5 text-center text-[12px] text-[var(--t-muted)]">暂无已归档来源文件</div>
        ) : (
          <div className="divide-y divide-[var(--bd-hair)]">
            {batches.map((batch) => (
              <div key={batch.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--teal-soft)] text-[var(--teal-deep)]"><FileSpreadsheet className="h-4 w-4" aria-hidden="true" /></div>
                <div className="min-w-[180px] flex-1">
                  <div className="truncate text-[13px] font-[550]">{batch.fileName}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--t-muted)]">{kindLabel(batch.kind)} · {shortDate(batch.periodStart)} 至 {shortDate(batch.periodEnd)} · {batch.rowCount} 行</div>
                </div>
                <Tag tone={batch.status === "COMMITTED" ? "green" : "amber"} dot>{batch.status === "COMMITTED" ? "已归档" : batch.status}</Tag>
                <span className="font-mono text-[10.5px] text-[var(--t-faint)]" title={batch.id}>{maskId(batch.id)}</span>
                {batch.errorCount > 0 ? <Tag tone="red"><XCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />{batch.errorCount} 行错误</Tag> : <Tag tone="slate"><CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden="true" />无行错误</Tag>}
                {batch.status === "COMMITTED" ? <a href={`/api/finance/internal/imports/${encodeURIComponent(batch.id)}/source`} className="btn btn-secondary btn-sm">下载来源</a> : null}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="工资、花名册与外部三表复核" icon={CheckCircle2} count={reviewRecords.filter((record) => record.reviewStatus === "NEEDS_REVIEW").length}>
        <p className="text-[12px] leading-relaxed text-[var(--t-secondary)]">系统不保存工资表和花名册中的姓名。请下载原文件，按批次与行号核对后手动关联律所人员；不会按姓名自动匹配。导入工资会登记为待复核事实，工资承担口径补全并确认前，月结仍会阻断。</p>
        {reviewRecords.length === 0 ? <div className="mt-3 text-[12px] text-[var(--t-muted)]">暂无待复核的类型化财务资料。</div> : <div className="mt-3 space-y-2.5">{reviewRecords.map((record) => <ImportReviewCard key={record.id} record={record} users={reviewUsers} canReview={canReview} onResolved={() => router.refresh()} />)}</div>}
        {reviewRecords.length >= 200 ? <div className="mt-3 text-[11px] text-[var(--t-muted)]">当前只显示最近 200 条类型化记录。</div> : null}
      </Panel>
    </div>
  );
}

function ImportReviewCard({ record, users, canReview, onResolved }: {
  record: FinanceImportReviewRow;
  users: Array<{ id: string; name: string; role: string }>;
  canReview: boolean;
  onResolved: () => void;
}) {
  const [targetUserId, setTargetUserId] = useState(record.resolvedUserId ?? "");
  const [busy, setBusy] = useState(false);
  const isExternal = record.kind === "EXTERNAL_THREE_STATEMENTS";
  const isResolved = record.reviewStatus === "RESOLVED";
  const typeLabel = kindLabel(record.kind);
  const period = record.period ?? record.asOfDay ?? "未标期间";

  async function resolve() {
    setBusy(true);
    try {
      await readJson(await fetch(`/api/finance/internal/imports/${encodeURIComponent(record.id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: isExternal ? null : targetUserId || null })
      }));
      toast.success(isExternal ? "外部报表已标记为人工核对" : record.kind === "PAYROLL" ? "已关联人员，工资承担口径仍待复核" : "花名册来源行已关联，未修改人员档案");
      onResolved();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[9px] border border-[var(--bd-hair)] bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-[600]">{typeLabel} · 第 {record.sourceRow} 行 · {period}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--t-muted)]">{record.batchFileName} · 批次 {maskId(record.batchId)}</div>
        </div>
        <Tag tone={isResolved ? "green" : "amber"} dot>{isResolved ? record.kind === "PAYROLL" ? "已登记，承担口径待复核" : "已人工复核" : "待人工复核"}</Tag>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--t-secondary)]">
        {record.kind === "PAYROLL" ? <><span>申报工资 {record.declaredSalary ?? "—"}</span><span>实付 {record.actualCashPaid ?? "—"}</span><span>个人自担 {record.selfCostDue ?? "—"}</span></> : null}
        {record.kind === "ROSTER" ? <><span>身份/岗位 {record.roleLabel ?? "—"}</span><span>截至 {record.asOfDay ?? "—"}</span></> : null}
        {isExternal ? <><span>报表 {record.statement ?? "—"}</span><span>{record.item ?? "—"}</span><span>金额 {record.amount ?? "—"}</span></> : null}
        {record.resolvedUserName ? <span>关联人员 {record.resolvedUserName}</span> : null}
        <a href={`/api/finance/internal/imports/${encodeURIComponent(record.batchId)}/source`} className="text-[var(--teal-deep)] no-underline">下载来源文件核对</a>
      </div>
      {isResolved ? record.kind === "PAYROLL" ? <a href={`/finance/internal/ledger?period=${encodeURIComponent(record.period ?? "")}`} className="mt-2 inline-block text-[11px] text-[var(--teal-deep)] no-underline">继续补全工资承担口径 →</a> : null : canReview ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {!isExternal ? <label className="min-w-[220px] flex-1 space-y-1 text-[11px] text-[var(--t-secondary)]"><span>人工选择在职人员</span><select aria-label={`第 ${record.sourceRow} 行关联人员`} value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} className="ll-form-control h-9 w-full rounded-[8px] border border-input bg-card px-2.5 text-[12px]"><option value="">选择人员</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select></label> : null}
          <Button type="button" size="sm" disabled={busy || (!isExternal && !targetUserId)} onClick={() => void resolve()}>{busy ? "提交中…" : isExternal ? "标记已核对" : record.kind === "PAYROLL" ? "关联并登记待复核工资" : "确认人员关联"}</Button>
        </div>
      ) : <div className="mt-2 text-[11px] text-[var(--t-muted)]">当前账号只有查看权限，需财务调整权限才能确认。</div>}
    </div>
  );
}

function PreviewBlock({ preview, busy, onCommit }: { preview: FinanceImportPreview; busy: "preview" | "commit" | null; onCommit: () => void }) {
  return (
    <div className="rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-[600]">{preview.fileName}</div>
          <div className="mt-1 text-[11.5px] text-[var(--t-muted)]">可提交 {preview.validCount} 行 · 文件共 {preview.totalRows} 行 · {kindLabel(preview.kind)}</div>
        </div>
        <Button type="button" size="sm" variant="approve" disabled={busy !== null || preview.errors.length > 0 || preview.validCount === 0} onClick={onCommit}>
          {busy === "commit" ? "归档中…" : "提交到归档"}
        </Button>
      </div>
      {preview.reviewWarnings?.map((warning) => <div key={warning} className="mt-2 rounded-[7px] bg-[var(--amber-bg)] px-2.5 py-2 text-[11.5px] text-[var(--amber)]">{warning}</div>)}
      {preview.errors.length > 0 ? <ErrorList errors={preview.errors} /> : <PreviewRows rows={preview.rows.slice(0, 8)} kind={preview.kind} />}
      {preview.rows.length > 8 ? <div className="mt-2 text-[11px] text-[var(--t-muted)]">仅展示前 8 行，提交时会保存全部有效行。</div> : null}
    </div>
  );
}

function ErrorList({ errors }: { errors: FinanceRowError[] }) {
  return (
    <div className="mt-3 rounded-[8px] border border-[var(--red-line)] bg-[var(--red-bg)] p-3 text-[12px] text-[var(--red)]">
      <div className="font-[600]">有 {errors.length} 行需要先修正</div>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        {errors.slice(0, 6).map((error) => <li key={`${error.rowNumber}-${error.code}`}>第 {error.rowNumber} 行：{error.message}</li>)}
      </ul>
      {errors.length > 6 ? <div className="mt-1">其余错误请下载原文件后核对。</div> : null}
    </div>
  );
}

function PreviewRows({ rows, kind }: { rows: FinanceImportPreview["rows"]; kind: string }) {
  if (rows.length === 0) return <div className="mt-3 text-[12px] text-[var(--t-muted)]">没有可展示的有效行。</div>;
  if (kind === "PAYROLL") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[620px] text-[11.5px]"><thead><tr><th>行</th><th>姓名（脱敏）</th><th>账期</th><th className="text-right">申报工资</th><th className="text-right">实际支付</th><th className="text-right">自担成本</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { declaredSalary: string }>; return <tr key={row.sourceRowNumber}><td>{row.sourceRowNumber}</td><td>{row.displayName}</td><td>{row.period}</td><td className="text-right font-mono">{row.declaredSalary}</td><td className="text-right font-mono">{row.actualCashPaid}</td><td className="text-right font-mono">{row.selfCostDue}</td></tr>; })}</tbody></table></div>
  );
  if (kind === "ROSTER") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[420px] text-[11.5px]"><thead><tr><th>行</th><th>姓名（脱敏）</th><th>身份/岗位</th><th>截至日期</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { roleLabel: string }>; return <tr key={row.sourceRowNumber}><td>{row.sourceRowNumber}</td><td>{row.displayName}</td><td>{row.roleLabel}</td><td>{row.asOfDay}</td></tr>; })}</tbody></table></div>
  );
  if (kind === "EXTERNAL_THREE_STATEMENTS") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[480px] text-[11.5px]"><thead><tr><th>行</th><th>期间</th><th>报表</th><th>项目</th><th className="text-right">金额</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { statement: string }>; return <tr key={row.sourceRowNumber}><td>{row.sourceRowNumber}</td><td>{row.period}</td><td>{row.statement === "BALANCE_SHEET" ? "资产负债表" : row.statement === "INCOME" ? "利润表" : "现金流量表"}</td><td>{row.item}</td><td className="text-right font-mono">{row.amount}</td></tr>; })}</tbody></table></div>
  );
  if (kind !== "BANK_STATEMENT") return <div className="mt-3 text-[12px] text-[var(--t-muted)]">该资料仅归档原文件，不会进入银行对账或财务计算。</div>;
  const bankRows = rows as FinanceNormalizedRow[];
  return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card">
      <table className="mo-table min-w-[620px] text-[11.5px]">
        <thead><tr><th>行</th><th>日期</th><th>方向</th><th className="text-right">金额</th><th>对方</th><th>摘要</th></tr></thead>
        <tbody>{bankRows.map((row) => <tr key={row.sourceRowNumber}><td>{row.sourceRowNumber}</td><td>{row.occurredAt}</td><td>{row.direction === "CREDIT" ? "收入" : row.direction === "DEBIT" ? "支出" : "未知"}</td><td className="text-right font-mono">{row.amount}</td><td className="max-w-[170px] truncate">{row.counterparty || "—"}</td><td className="max-w-[200px] truncate">{row.description || "—"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
