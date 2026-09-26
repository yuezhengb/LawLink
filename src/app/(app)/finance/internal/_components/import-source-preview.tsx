"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/patterns/moan";
import type { FinanceImportSourcePreview } from "@/server/finance/internal-imports";

async function readPreview(response: Response): Promise<FinanceImportSourcePreview> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "请求失败");
  return body as FinanceImportSourcePreview;
}

export function ImportSourcePreview({ batchId }: { batchId: string }) {
  const [preview, setPreview] = useState<FinanceImportSourcePreview | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(`/api/finance/internal/imports/${encodeURIComponent(batchId)}/preview?sheet=${sheetIndex}&page=${page}`, { cache: "no-store" })
      .then(readPreview)
      .then((result) => { if (active) setPreview(result); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "来源数据预览失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [batchId, sheetIndex, page, retryCount]);

  const selected = preview?.selectedSheet ?? null;
  const columnCount = selected?.rows.reduce((max, row) => Math.max(max, row.cells.length), 0) ?? 0;
  const downloadHref = `/api/finance/internal/imports/${encodeURIComponent(batchId)}/source`;

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-[600]"><FileSpreadsheet className="h-4 w-4 text-[var(--teal-deep)]" aria-hidden="true" />{preview?.fileName ?? "来源资料"}</div>
            <p className="mt-1 text-[11.5px] text-[var(--t-muted)]">原表只读预览 · 不会改写案件、收付款、开票或账簿事实</p>
          </div>
          <div className="flex items-center gap-2">
            {preview ? <Tag tone="slate">{preview.kind}</Tag> : null}
            <a href={downloadHref} className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"><Download className="h-3.5 w-3.5" aria-hidden="true" />下载原件</a>
          </div>
        </div>
      </section>

      {loading ? <div role="status" className="card p-5 text-[12px] text-[var(--t-muted)]">正在读取受保护来源…</div> : null}
      {error ? <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 border-[var(--red-line)] p-5 text-[12px] text-[var(--red)]">
        <span>{error}</span>
        <Button size="sm" variant="secondary" onClick={() => setRetryCount((value) => value + 1)}>重试</Button>
      </div> : null}
      {!loading && preview && !preview.available ? <div className="card p-5 text-[12px] text-[var(--t-secondary)]">{preview.unavailableReason}</div> : null}

      {!loading && preview?.available && selected ? <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--bd-hair)] px-4 py-3">
          <div>
            <div className="text-[13px] font-[600]">{selected.name}</div>
            <div className="mt-0.5 text-[11px] text-[var(--t-muted)]">共 {selected.totalRows} 行 · 第 {selected.page}/{selected.totalPages} 页</div>
          </div>
          <div className="flex items-center gap-2">
            {selected.page > 1 ? <Button size="sm" variant="secondary" onClick={() => setPage((value) => value - 1)}><ArrowLeft aria-hidden="true" />上一页</Button> : null}
            {selected.page < selected.totalPages ? <Button size="sm" variant="secondary" onClick={() => setPage((value) => value + 1)}>下一页<ArrowRight aria-hidden="true" /></Button> : null}
          </div>
        </div>
        {preview.sheetCount > 1 ? <div className="flex flex-wrap gap-2 border-b border-[var(--bd-hair)] px-4 py-3">
          {Array.from({ length: preview.sheetCount }, (_, index) => index).map((index) => (
            <Button key={index} size="sm" variant={index === selected.index ? "default" : "secondary"} onClick={() => { setSheetIndex(index); setPage(1); }}>
              {index === selected.index ? selected.name : `工作表 ${index + 1}`}
            </Button>
          ))}
        </div> : null}
        {preview.ocrCandidatePages.length ? <div className="border-b border-[var(--amber-line)] bg-[var(--amber-bg)] px-4 py-2.5 text-[11.5px] text-[var(--amber)]">PDF 第 {preview.ocrCandidatePages.join("、")} 页未形成稳定表格，未写入结构化记录；请下载原件人工核对。</div> : null}
        <div className="max-h-[70vh] overflow-auto">
          <table aria-label="来源原表内容" className="w-max min-w-full border-collapse text-left text-[11.5px]">
            <caption className="sr-only">来源原表内容，按工作表和原始行号只读展示</caption>
            <thead className="sticky top-0 z-[1] bg-[var(--bg-sunken)] text-[var(--t-muted)]">
              <tr><th scope="col" className="sticky left-0 bg-[var(--bg-sunken)] px-3 py-2 font-[550]">原表行</th>{Array.from({ length: columnCount }, (_, index) => <th key={index} scope="col" className="min-w-[150px] px-3 py-2 font-[550]">第 {index + 1} 列</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--bd-hair)]">
              {selected.rows.map((row) => <tr key={row.sourceRow}>
                <th scope="row" className="sticky left-0 bg-card px-3 py-2 text-left font-mono font-normal text-[var(--t-muted)]">{row.sourceRow}</th>
                {Array.from({ length: columnCount }, (_, index) => <td key={index} className="max-w-[320px] whitespace-pre-wrap break-words px-3 py-2 align-top">{row.cells[index] ?? ""}</td>)}
              </tr>)}
            </tbody>
          </table>
        </div>
      </section> : null}
    </div>
  );
}
