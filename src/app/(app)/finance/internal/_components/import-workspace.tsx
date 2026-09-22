"use client";

import { useState } from "react";
import { Archive, CheckCircle2, Eye, FileSpreadsheet, UploadCloud, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import type { FinanceImportPreview, FinanceRowError, FinanceNormalizedRow } from "@/lib/finance/internal-types";
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

export function ImportWorkspace({ batches, canImport }: { batches: InternalImportBatch[]; canImport: boolean }) {
  const [kind, setKind] = useState("BANK_STATEMENT");
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
            <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
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
      {preview.errors.length > 0 ? <ErrorList errors={preview.errors} /> : <PreviewRows rows={preview.rows.slice(0, 8)} />}
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

function PreviewRows({ rows }: { rows: FinanceNormalizedRow[] }) {
  if (rows.length === 0) return <div className="mt-3 text-[12px] text-[var(--t-muted)]">没有可展示的有效行。</div>;
  return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card">
      <table className="mo-table min-w-[620px] text-[11.5px]">
        <thead><tr><th>行</th><th>日期</th><th>方向</th><th className="text-right">金额</th><th>对方</th><th>摘要</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.sourceRowNumber}><td>{row.sourceRowNumber}</td><td>{row.occurredAt}</td><td>{row.direction === "CREDIT" ? "收入" : row.direction === "DEBIT" ? "支出" : "未知"}</td><td className="text-right font-mono">{row.amount}</td><td className="max-w-[170px] truncate">{row.counterparty || "—"}</td><td className="max-w-[200px] truncate">{row.description || "—"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
