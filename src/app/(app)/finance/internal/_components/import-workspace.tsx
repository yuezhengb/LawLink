"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CheckCircle2, Eye, FileSpreadsheet, Save, Trash2, UploadCloud, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "@/components/patterns/moan";
import { actionErrorMessage } from "@/lib/action-error";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import type { FinanceColumnMappingsBySheet, FinanceImportField, FinanceImportIndexMapping, FinanceImportPreview, FinanceRowError, FinanceNormalizedRow } from "@/lib/finance/internal-types";
import type { CaseRegisterPreviewResult } from "@/server/finance/case-register-preview";
import type { FinanceImportReviewRow } from "@/server/finance/internal-import-review";
import type { InternalImportBatch } from "./types";

const KIND_OPTIONS = [
  ["BANK_STATEMENT", "银行流水"],
  ["PAYROLL", "工资表"],
  ["ROSTER", "花名册"],
  ["EXTERNAL_THREE_STATEMENTS", "外账三表"],
  ["OTHER", "其他财务资料"]
] as const;

const MAPPING_FIELDS: Partial<Record<string, Array<[FinanceImportField, string]>>> = {
  BANK_STATEMENT: [["occurredAt", "交易日期"], ["counterparty", "交易对方"], ["debit", "借方金额"], ["credit", "贷方金额"], ["amount", "交易金额"], ["balance", "余额"], ["account", "账户"], ["description", "摘要/用途"], ["externalReference", "流水号"], ["invoiceReference", "发票号"]],
  PAYROLL: [["period", "工资期间"], ["name", "人员姓名"], ["salary", "申报工资"], ["actual", "实际支付"], ["selfCost", "个人承担成本"]],
  ROSTER: [["name", "人员姓名"], ["role", "身份/岗位"]],
  EXTERNAL_THREE_STATEMENTS: [["period", "报表期间"], ["statement", "报表类型"], ["item", "项目/科目"], ["amount", "金额"]]
};

type FinanceMappingTemplate = { id: string; kind: string; headersDigest: string; mapping: FinanceImportIndexMapping; updatedAt: string };

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
  const [columnMappingsBySheet, setColumnMappingsBySheet] = useState<FinanceColumnMappingsBySheet>({});
  const [mappingDirty, setMappingDirty] = useState(false);
  const [mappingTemplates, setMappingTemplates] = useState<FinanceMappingTemplate[]>([]);
  const [caseRegisterFile, setCaseRegisterFile] = useState<File | null>(null);
  const [caseRegisterResult, setCaseRegisterResult] = useState<CaseRegisterPreviewResult | null>(null);
  const [caseRegisterBusy, setCaseRegisterBusy] = useState(false);
  const [caseRegisterArchiving, setCaseRegisterArchiving] = useState(false);

  useEffect(() => {
    if (!canImport) return;
    let active = true;
    void fetch(`/api/finance/internal/imports/mappings?kind=${encodeURIComponent(kind)}`, { cache: "no-store" })
      .then(readJson)
      .then((result) => {
        if (active) setMappingTemplates(Array.isArray(result.items) ? result.items as FinanceMappingTemplate[] : []);
      })
      .catch(() => { if (active) setMappingTemplates([]); });
    return () => { active = false; };
  }, [canImport, kind]);

  async function previewUpload() {
    if (!file) {
      toast.error("请先选择 CSV、XLSX、XLS 或 PDF 文件");
      return;
    }
    setBusy("preview");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      if (Object.keys(columnMappingsBySheet).length) form.append("columnMappingsBySheet", JSON.stringify(columnMappingsBySheet));
      if (period) form.append("period", period);
      if (asOfDay) form.append("asOfDay", asOfDay);
      const result = await readJson(await fetch("/api/finance/internal/imports/preview", { method: "POST", body: form }));
      setPreview(result as unknown as FinanceImportPreview);
      const sheets = (result.sheets as FinanceImportPreview["sheets"]) ?? [];
      setColumnMappingsBySheet(Object.fromEntries(sheets.map((sheet) => [sheet.sourceSheet, sheet.mapping])));
      setMappingDirty(false);
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
      if (Object.keys(columnMappingsBySheet).length) form.append("columnMappingsBySheet", JSON.stringify(columnMappingsBySheet));
      if (period) form.append("period", period);
      if (asOfDay) form.append("asOfDay", asOfDay);
      const result = await readJson(await fetch("/api/finance/internal/imports/commit", { method: "POST", body: form }));
      toast.success(result.duplicate ? "该文件已经归档，未重复写入" : "财务资料已归档");
      setPreview(null);
      setFile(null);
      setColumnMappingsBySheet({});
      setMappingDirty(false);
      window.location.reload();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function changeMapping(sourceSheet: string, field: FinanceImportField, rawIndex: string) {
    setColumnMappingsBySheet((current) => {
      const next: FinanceImportIndexMapping = { ...(current[sourceSheet] ?? {}) };
      if (rawIndex === "") delete next[field];
      else next[field] = Number(rawIndex);
      return { ...current, [sourceSheet]: next };
    });
    setMappingDirty(true);
  }

  async function saveMappingTemplate(sheet: NonNullable<FinanceImportPreview["sheets"]>[number]) {
    const mapping = columnMappingsBySheet[sheet.sourceSheet] ?? sheet.mapping;
    try {
      const result = await readJson(await fetch("/api/finance/internal/imports/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, headersDigest: sheet.headersDigest, mapping })
      }));
      const saved = result as unknown as FinanceMappingTemplate;
      setMappingTemplates((current) => [saved, ...current.filter((template) => template.headersDigest !== saved.headersDigest)]);
      toast.success("字段映射已保存，可在相同表头的文件中复用");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    }
  }

  async function deleteMappingTemplate(template: FinanceMappingTemplate) {
    if (!(await confirmDialog({ title: "删除这条映射模板？", description: "已归档的来源不受影响；后续导入需重新选择字段。", confirmText: "删除模板", danger: true }))) return;
    try {
      await readJson(await fetch("/api/finance/internal/imports/mappings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: template.id })
      }));
      setMappingTemplates((current) => current.filter((item) => item.id !== template.id));
      toast.success("映射模板已删除");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    }
  }

  async function previewCaseRegister() {
    if (!caseRegisterFile) {
      toast.error("请先选择案件登记清单");
      return;
    }
    setCaseRegisterBusy(true);
    try {
      const form = new FormData();
      form.append("file", caseRegisterFile);
      const result = await readJson(await fetch("/api/finance/internal/imports/case-register-preview", { method: "POST", body: form }));
      setCaseRegisterResult(result as unknown as CaseRegisterPreviewResult);
      toast.success("只读比对完成；未修改案件或财务数据");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setCaseRegisterBusy(false);
    }
  }

  async function archiveCaseRegister() {
    if (!caseRegisterFile || !caseRegisterResult) return;
    setCaseRegisterArchiving(true);
    try {
      const form = new FormData();
      form.append("file", caseRegisterFile);
      form.append("kind", "OTHER");
      const result = await readJson(await fetch("/api/finance/internal/imports/commit", { method: "POST", body: form }));
      toast.success(result.duplicate ? "该清单原件已归档，可在来源列表查看" : "清单原件已归档，可在来源列表查看；未写入案件或账簿");
      setCaseRegisterFile(null);
      setCaseRegisterResult(null);
      window.location.reload();
    } catch (error) {
      toast.error(actionErrorMessage(error));
    } finally {
      setCaseRegisterArchiving(false);
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
                <select aria-label="资料类型" className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2.5 text-[13px]" value={kind} onChange={(event) => { setKind(event.target.value); setPreview(null); setColumnMappingsBySheet({}); setMappingDirty(false); }}>
                  {KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
                <span>来源文件</span>
              <Input aria-label="来源文件" type="file" accept=".csv,.xlsx,.xlsm,.xls,.pdf" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setColumnMappingsBySheet({}); setMappingDirty(false); }} />
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
                <Eye aria-hidden="true" />{busy === "preview" ? "预览中…" : preview ? "重新预览" : "上传并预览"}
              </Button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-[var(--t-muted)]">支持 CSV、XLSX、XLSM、传统 XLS 和 PDF。预览不会写入归档；“其他财务资料”只保存原件，不进入案件、收付款或财务计算。</p>
            {preview ? <PreviewBlock
              preview={preview}
              busy={busy}
              mappingBySheet={columnMappingsBySheet}
              mappingDirty={mappingDirty}
              templates={mappingTemplates.filter((template) => template.kind === preview.kind)}
              onChangeMapping={changeMapping}
              onApplyTemplate={(sheet, mapping) => { setColumnMappingsBySheet((current) => ({ ...current, [sheet]: mapping })); setMappingDirty(true); }}
              onSaveTemplate={(sheet) => void saveMappingTemplate(sheet)}
              onDeleteTemplate={(template) => void deleteMappingTemplate(template)}
              onCommit={() => void commitUpload()}
            /> : null}
          </div>
        ) : (
          <div className="mo-note">
            <Archive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t-muted)]" aria-hidden="true" />
            <span>当前账号可以查看已归档资料，但没有导入权限。需要新增来源时，请联系财务账号处理。</span>
          </div>
        )}
      </Panel>

      <Panel title="收案清单只读核对" icon={FileSpreadsheet} extra={<Tag tone="slate">不写入案件</Tag>}>
        {canImport ? <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[260px] flex-1 space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
              <span>案件登记清单（XLSX / XLSM）</span>
              <Input aria-label="案件登记清单" type="file" accept=".xlsx,.xlsm" onChange={(event) => { setCaseRegisterFile(event.target.files?.[0] ?? null); setCaseRegisterResult(null); }} />
            </label>
            <Button type="button" variant="secondary" onClick={() => void previewCaseRegister()} disabled={!caseRegisterFile || caseRegisterBusy}>
              <Eye aria-hidden="true" />{caseRegisterBusy ? "比对中…" : "只读比对"}
            </Button>
          </div>
          <p className="text-[11.5px] leading-relaxed text-[var(--t-muted)]">比对仅按案号精确核对，不读取或展示客户名称；归档后可在下方查看原表。原件只进入受权限保护的来源档案，不创建或修改案件、合同、收付款及账簿事实。</p>
          {caseRegisterResult ? <div className="space-y-3" aria-label="案件清单比对结果">
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[["清单行", caseRegisterResult.counts.totalRows], ["可比案号", caseRegisterResult.counts.comparableRows], ["匹配", caseRegisterResult.counts.matched], ["仅在清单", caseRegisterResult.counts.registerOnly], ["仅在系统", caseRegisterResult.counts.systemOnly], ["重复案号", caseRegisterResult.counts.duplicateRegister]].map(([label, count]) => <div key={label} className="rounded-[8px] border border-[var(--bd-hair)] bg-[var(--bg-sunken)] px-3 py-2"><div className="text-[10.5px] text-[var(--t-muted)]">{label}</div><div className="mt-1 text-[16px] font-[650] tabular-nums">{count}</div></div>)}
            </div>
            {caseRegisterResult.warnings.map((warning) => <div key={warning} className="mo-note">{warning}</div>)}
            {caseRegisterResult.sheetsSkipped ? <p className="text-[11px] text-[var(--t-muted)]">有 {caseRegisterResult.sheetsSkipped} 张工作表未识别，未纳入比对。</p> : null}
            {caseRegisterResult.differences.length ? <div className="max-h-[320px] overflow-auto rounded-[8px] border border-[var(--bd-hair)]">
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 bg-[var(--bg-sunken)] text-[var(--t-muted)]"><tr><th className="px-3 py-2 font-[550]">差异</th><th className="px-3 py-2 font-[550]">案号</th><th className="px-3 py-2 font-[550]">合同编号（未比对）</th></tr></thead>
                <tbody className="divide-y divide-[var(--bd-hair)]">{caseRegisterResult.differences.map((difference, index) => <tr key={`${difference.status}-${difference.caseNumber}-${index}`}><td className="px-3 py-2">{difference.status === "REGISTER_ONLY" ? "仅在清单" : difference.status === "SYSTEM_ONLY" ? "仅在系统" : "清单重复"}</td><td className="px-3 py-2 font-mono">{difference.caseNumber}</td><td className="px-3 py-2 font-mono">{difference.contractNumber ?? "—"}</td></tr>)}</tbody>
              </table>
            </div> : <p className="text-[12px] text-[var(--t-muted)]">没有案号差异。</p>}
            {caseRegisterResult.counts.registerOnly + caseRegisterResult.counts.systemOnly + caseRegisterResult.counts.duplicateRegister > caseRegisterResult.differences.length ? <p className="text-[11px] text-[var(--t-muted)]">差异明细最多显示 500 条，汇总计数覆盖全部可识别行。</p> : null}
            <Button type="button" variant="approve" onClick={() => void archiveCaseRegister()} disabled={caseRegisterArchiving || caseRegisterBusy}>
              <Archive aria-hidden="true" />{caseRegisterArchiving ? "归档中…" : "归档原件并在财务区查看"}
            </Button>
          </div> : null}
        </div> : <p className="text-[12px] text-[var(--t-muted)]">当前账号没有案件清单核对权限。</p>}
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
                {batch.status === "COMMITTED" ? <>
                  <a href={`/finance/internal/imports/${encodeURIComponent(batch.id)}`} className="btn btn-secondary btn-sm">查看数据</a>
                  <a href={`/api/finance/internal/imports/${encodeURIComponent(batch.id)}/source`} className="btn btn-secondary btn-sm">下载来源</a>
                </> : null}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="工资、花名册与外部三表复核" icon={CheckCircle2} count={reviewRecords.filter((record) => record.reviewStatus === "NEEDS_REVIEW").length}>
        <p className="text-[12px] leading-relaxed text-[var(--t-secondary)]">工资表和花名册中的姓名只保存在内部财务复核记录，供有财务读取权限的人员核对；系统不会按姓名自动匹配人员。导入工资会登记为待复核事实，工资承担口径补全并确认前，月结仍会阻断。</p>
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
          <div className="text-[12px] font-[600]">{typeLabel} · {record.sourceSheet && record.sourceSheet !== "CSV" ? `${record.sourceSheet} · ` : ""}第 {record.sourceRow} 行 · {period}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--t-muted)]">{record.batchFileName} · 批次 {maskId(record.batchId)}</div>
        </div>
        <Tag tone={isResolved ? "green" : "amber"} dot>{isResolved ? record.kind === "PAYROLL" ? "已登记，承担口径待复核" : "已人工复核" : "待人工复核"}</Tag>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--t-secondary)]">
        {record.displayName ? <span>来源姓名 {record.displayName}</span> : null}
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

function PreviewBlock({
  preview,
  busy,
  mappingBySheet,
  mappingDirty,
  templates,
  onChangeMapping,
  onApplyTemplate,
  onSaveTemplate,
  onDeleteTemplate,
  onCommit
}: {
  preview: FinanceImportPreview;
  busy: "preview" | "commit" | null;
  mappingBySheet: FinanceColumnMappingsBySheet;
  mappingDirty: boolean;
  templates: FinanceMappingTemplate[];
  onChangeMapping: (sourceSheet: string, field: FinanceImportField, index: string) => void;
  onApplyTemplate: (sourceSheet: string, mapping: FinanceImportIndexMapping) => void;
  onSaveTemplate: (sheet: NonNullable<FinanceImportPreview["sheets"]>[number]) => void;
  onDeleteTemplate: (template: FinanceMappingTemplate) => void;
  onCommit: () => void;
}) {
  const canCommit = busy === null
    && !mappingDirty
    && preview.canCommitStructuredRows !== false
    && !preview.sheets?.some((sheet) => sheet.missingFields.length > 0)
    && preview.errors.length === 0
    && (preview.validCount > 0 || preview.kind === "OTHER");
  return (
    <div className="rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-[600]">{preview.fileName}</div>
          <div className="mt-1 text-[11.5px] text-[var(--t-muted)]">可提交 {preview.validCount} 行 · 文件共 {preview.totalRows} 行 · {kindLabel(preview.kind)}</div>
        </div>
        <Button type="button" size="sm" variant="approve" disabled={!canCommit} onClick={onCommit}>
          {busy === "commit" ? "归档中…" : "提交到归档"}
        </Button>
      </div>
      {mappingDirty ? <div role="status" className="mt-2 rounded-[7px] bg-[var(--amber-bg)] px-2.5 py-2 text-[11.5px] text-[var(--amber)]">字段映射已更改，请重新预览后再提交。</div> : null}
      {preview.kind === "OTHER" ? <div className="mt-2 rounded-[7px] border border-[var(--bd-hair)] bg-card px-2.5 py-2 text-[11.5px] text-[var(--t-secondary)]">仅归档原件及可读取行数，不会转成案件、收付款、开票或财务计算记录。</div> : null}
      {preview.sheets?.map((sheet) => <MappingSheetCard
        key={sheet.sourceSheet}
        kind={preview.kind}
        sheet={sheet}
        mapping={mappingBySheet[sheet.sourceSheet] ?? sheet.mapping}
        templates={templates.filter((template) => template.headersDigest === sheet.headersDigest)}
        mappingDirty={mappingDirty}
        onChange={(field, index) => onChangeMapping(sheet.sourceSheet, field, index)}
        onApplyTemplate={(mapping) => onApplyTemplate(sheet.sourceSheet, mapping)}
        onSave={() => onSaveTemplate(sheet)}
        onDelete={onDeleteTemplate}
      />)}
      {preview.reviewWarnings?.map((warning) => <div key={warning} className="mt-2 rounded-[7px] bg-[var(--amber-bg)] px-2.5 py-2 text-[11.5px] text-[var(--amber)]">{warning}</div>)}
      {preview.pdfCandidates?.length ? <div className="mt-2 rounded-[7px] border border-[var(--amber-line)] bg-[var(--amber-bg)] px-2.5 py-2 text-[11.5px] text-[var(--amber)]">PDF 第 {preview.pdfCandidates.map((page) => page.pageNumber).join("、")} 页未能形成可复核表格。请人工整理后重新导入；本文件当前不可提交为结构化财务记录。</div> : null}
      {preview.errors.length > 0 ? <ErrorList errors={preview.errors} /> : <PreviewRows rows={preview.rows.slice(0, 8)} kind={preview.kind} />}
      {preview.rows.length > 8 ? <div className="mt-2 text-[11px] text-[var(--t-muted)]">仅展示前 8 行，提交时会保存全部有效行。</div> : null}
    </div>
  );
}

function MappingSheetCard({
  kind,
  sheet,
  mapping,
  templates,
  mappingDirty,
  onChange,
  onApplyTemplate,
  onSave,
  onDelete
}: {
  kind: string;
  sheet: NonNullable<FinanceImportPreview["sheets"]>[number];
  mapping: FinanceImportIndexMapping;
  templates: FinanceMappingTemplate[];
  mappingDirty: boolean;
  onChange: (field: FinanceImportField, index: string) => void;
  onApplyTemplate: (mapping: FinanceImportIndexMapping) => void;
  onSave: () => void;
  onDelete: (template: FinanceMappingTemplate) => void;
}) {
  const fields = MAPPING_FIELDS[kind] ?? [];
  const template = templates[0];
  return (
    <section className="mt-3 rounded-[8px] border border-[var(--bd-subtle)] bg-card p-3" aria-label={`${sheet.sourceSheet} 字段映射`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[12px] font-[600]">{sheet.sourceSheet} · 表头第 {sheet.headerRowNumber} 行</div>
          <div className="mt-0.5 text-[10.5px] text-[var(--t-muted)]">表头摘要 {sheet.headersDigest.slice(0, 12)}… · {sheet.headers.length} 列</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {template ? <>
            <Button type="button" size="sm" variant="secondary" disabled={mappingDirty} onClick={() => onApplyTemplate(template.mapping)}>应用已存映射</Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => onDelete(template)} aria-label="删除映射模板"><Trash2 aria-hidden="true" />删除模板</Button>
          </> : null}
          <Button type="button" size="sm" variant="secondary" disabled={mappingDirty || Object.keys(mapping).length === 0} onClick={onSave}><Save aria-hidden="true" />保存映射</Button>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([field, label]) => (
          <label key={field} className="block space-y-1 text-[11px] font-[550] text-[var(--t-secondary)]">
            <span>{label}</span>
            <select
              aria-label={`${sheet.sourceSheet} ${label}列`}
              className="ll-form-control h-9 w-full rounded-[8px] border border-input bg-card px-2 text-[12px]"
              value={mapping[field] ?? ""}
              onChange={(event) => onChange(field, event.target.value)}
            >
              <option value="">未选择</option>
              {sheet.headers.map((header, index) => <option key={index} value={index}>第 {index + 1} 列 · {header || "空表头"}</option>)}
            </select>
          </label>
        ))}
      </div>
      {sheet.missingFields.length > 0 ? <div className="mt-2 text-[11px] text-[var(--amber)]">尚未匹配必需字段：{sheet.missingFields.join("、")}。</div> : null}
    </section>
  );
}

function ErrorList({ errors }: { errors: FinanceRowError[] }) {
  return (
    <div className="mt-3 rounded-[8px] border border-[var(--red-line)] bg-[var(--red-bg)] p-3 text-[12px] text-[var(--red)]">
      <div className="font-[600]">有 {errors.length} 行需要先修正</div>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        {errors.slice(0, 6).map((error) => <li key={`${error.sourceSheet ?? ""}-${error.rowNumber}-${error.code}`}>{error.sourceSheet ? `${error.sourceSheet} · ` : ""}第 {error.rowNumber} 行：{error.message}</li>)}
      </ul>
      {errors.length > 6 ? <div className="mt-1">其余错误请下载原文件后核对。</div> : null}
    </div>
  );
}

function PreviewRows({ rows, kind }: { rows: FinanceImportPreview["rows"]; kind: string }) {
  if (rows.length === 0) return <div className="mt-3 text-[12px] text-[var(--t-muted)]">没有可展示的有效行。</div>;
  if (kind === "PAYROLL") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[760px] text-[11.5px]"><thead><tr><th>工作表</th><th>行</th><th>姓名（脱敏）</th><th>账期</th><th className="text-right">申报工资</th><th className="text-right">实际支付</th><th className="text-right">自担成本</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { declaredSalary: string }>; return <tr key={`${row.sourceSheet ?? ""}-${row.sourceRowNumber}`}><td>{row.sourceSheet || "CSV"}</td><td>{row.sourceRowNumber}</td><td>{row.displayName}</td><td>{row.period}</td><td className="text-right font-mono">{row.declaredSalary}</td><td className="text-right font-mono">{row.actualCashPaid}</td><td className="text-right font-mono">{row.selfCostDue}</td></tr>; })}</tbody></table></div>
  );
  if (kind === "ROSTER") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[540px] text-[11.5px]"><thead><tr><th>工作表</th><th>行</th><th>姓名（脱敏）</th><th>身份/岗位</th><th>截至日期</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { roleLabel: string }>; return <tr key={`${row.sourceSheet ?? ""}-${row.sourceRowNumber}`}><td>{row.sourceSheet || "CSV"}</td><td>{row.sourceRowNumber}</td><td>{row.displayName}</td><td>{row.roleLabel}</td><td>{row.asOfDay}</td></tr>; })}</tbody></table></div>
  );
  if (kind === "EXTERNAL_THREE_STATEMENTS") return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card"><table className="mo-table min-w-[620px] text-[11.5px]"><thead><tr><th>工作表</th><th>行</th><th>期间</th><th>报表</th><th>项目</th><th className="text-right">金额</th></tr></thead><tbody>{rows.map((item) => { const row = item as Extract<FinanceImportPreview["rows"][number], { statement: string }>; return <tr key={`${row.sourceSheet ?? ""}-${row.sourceRowNumber}`}><td>{row.sourceSheet || "CSV"}</td><td>{row.sourceRowNumber}</td><td>{row.period}</td><td>{row.statement === "BALANCE_SHEET" ? "资产负债表" : row.statement === "INCOME" ? "利润表" : "现金流量表"}</td><td>{row.item}</td><td className="text-right font-mono">{row.amount}</td></tr>; })}</tbody></table></div>
  );
  if (kind !== "BANK_STATEMENT") return <div className="mt-3 text-[12px] text-[var(--t-muted)]">该资料仅归档原文件，不会进入银行对账或财务计算。</div>;
  const bankRows = rows as FinanceNormalizedRow[];
  return (
    <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)] bg-card">
      <table className="mo-table min-w-[620px] text-[11.5px]">
        <thead><tr><th>工作表</th><th>行</th><th>日期</th><th>方向</th><th className="text-right">金额</th><th>对方（脱敏）</th><th>摘要</th></tr></thead>
        <tbody>{bankRows.map((row) => <tr key={`${row.sourceSheet ?? ""}-${row.sourceRowNumber}`}><td>{row.sourceSheet || "CSV"}</td><td>{row.sourceRowNumber}</td><td>{row.occurredAt}</td><td>{row.direction === "CREDIT" ? "收入" : row.direction === "DEBIT" ? "支出" : "未知"}</td><td className="text-right font-mono">{row.amount}</td><td className="max-w-[170px] truncate">{row.counterparty || "—"}</td><td className="max-w-[200px] truncate">{row.description || "—"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
