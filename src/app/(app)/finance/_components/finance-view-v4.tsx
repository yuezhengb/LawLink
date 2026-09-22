"use client";

/**
 * 财务（墨案 08 效果图）：KPI 四卡 → 分段（收付流水 / 开票管理 / 律师分成 / 应收账龄）→
 * 趋势 + 开票进度 → 收付流水表。已确认口径沿用 P0-6 规则（关联已签署合同或已登记发票号）。
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { DollarSign, FileText, Search, Users, Clock3, Plus } from "lucide-react";
import type { InvoiceReconciliation } from "@/lib/finance/invoice-reconciliation";
import type { InvoiceRequestRow } from "./finance-view";
import type { getReceivablesAging } from "@/server/finance/aging";
import { RevenueChart } from "@/components/dashboard/revenue-chart";
import { InvoiceManagementSection } from "./invoice-management";
import { InvoiceCreateDialog } from "./invoice-create-dialog";
import { RecordFeeLauncher } from "./record-fee-launcher";
import { MetricCard, PageHeader, Segmented } from "@/components/patterns/moan";
import { FilterSelect } from "@/components/patterns/filter-select";
import { confirmFeeEntry, rejectFeeEntry } from "@/server/finance/actions";
import { promptDialog } from "@/components/patterns/confirm-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useTopbarAction } from "@/components/layout/topbar-action";
import { invoiceRequestStatusLabel } from "@/lib/enums";
import { matterHref } from "@/lib/matters/route";
import { cn } from "@/lib/utils";
import { shMonthDay, shParts } from "@/lib/ui/sh-time";
import { moneyKindLabels, type MoneyKind } from "@/lib/finance/ledger-labels";
import { actionErrorMessage } from "@/lib/action-error";

type Entry = {
  moneyKind?: MoneyKind;
  id: string;
  type: "RECEIVABLE" | "RECEIVED" | "REFUND" | "COST" | "COMMISSION";
  amount: number;
  occurredAt: Date;
  payerOrPayee: string | null;
  method: string | null;
  invoiceNo: string | null;
  note: string | null;
  confirmed: boolean;
  /** 实收确认：任何人登记的实收都先为 PENDING，经「确认实收到账」权限的人确认后才计入已实收（2026-09-19） */
  confirmState: "PENDING" | "CONFIRMED";
  matter: { id: string; internalCode: string; title: string };
  commissionAccrued?: number;
  commissionNetPaid?: number;
  commissionRecoverable?: number;
  beneficiaryUser: { id: string; name: string } | null;
  recordedBy: { id: string; name: string };
  confirmedBy: { id: string; name: string } | null;
};

type Aging = Awaited<ReturnType<typeof getReceivablesAging>>;

type Props = {
  entries: Entry[];
  monthly: { month: string; received: number; receivable: number }[];
  aging: Aging;
  stats: {
    ledgerReady?: boolean;
    monthlyReceived: number;
    monthlyReceivable: number;
    yearlyReceived: number;
    yearlyReceivable: number;
    lastMonthReceived: number;
    personalMonthly: number;
    personalYearly: number;
    monthlyIssued: number;
    pendingInvoiceCount: number;
    /** 本月实收笔数与待确认合计：库内统计，不受流水条数上限影响 */
    monthConfirmedCount: number;
    monthPendingCount: number;
    monthPendingAmount: number;
    /** 本月确认的退款/冲正更正合计（正值）：净实收为负时卡片注明构成，避免「¥-10,000 · 已确认 1 笔」不可解 */
    monthRefundAmount?: number;
    /** D 批：本期新增应收的当前核销率（%，分母为零时为 null——不显示为 0%） */
    writeOffRate?: number | null;
  };
  invoiceRequests: InvoiceRequestRow[];
  /** 全部待确认实收，与流水分页无关 */
  pendingEntries?: Entry[];
  /** 分成流水独立查询，避免混在 500 条流水里被截断 */
  commissionEntries?: Entry[];
  invoiceReconciliation: InvoiceReconciliation[];
  canApproveInvoice: boolean;
  canExport: boolean;
  canInternalRead: boolean;
  canWrite: boolean;
  /** 能否确认 / 退回律师登记的实收（财务、主任、管理员） */
  canConfirmReceipt: boolean;
};

type Tab = "ledger" | "invoices" | "commission" | "aging";

const TYPE_META: Record<Entry["type"], { label: string; badge: string; sign: string; cls: string }> = {
  RECEIVED: { label: "收款", badge: "b-green", sign: "+", cls: "in" },
  RECEIVABLE: { label: "应收", badge: "b-amber", sign: "", cls: "" },
  COST: { label: "付款", badge: "b-slate", sign: "−", cls: "out" },
  REFUND: { label: "退款", badge: "b-red", sign: "−", cls: "out" },
  COMMISSION: { label: "分成", badge: "b-violet", sign: "", cls: "out" }
};

const yuan = (n: number, digits = 0) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const mmdd = (d: Date | string) => shMonthDay(d);

export function FinanceViewV4({ entries, monthly, aging, stats, invoiceRequests, pendingEntries, commissionEntries: commissionRows, invoiceReconciliation, canApproveInvoice, canExport, canInternalRead, canWrite, canConfirmReceipt }: Props) {
  const params = useSearchParams();
  const initialTab = (["ledger", "invoices", "commission", "aging"] as Tab[]).includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "ledger";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState("");
  const [range, setRange] = useState<string | undefined>("90");
  const [typeFilter, setTypeFilter] = useState<Entry["type"] | undefined>(undefined);
  const [invoiceCreateOpen, setInvoiceCreateOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const router = useRouter();

  async function confirmOne(id: string) {
    setBusyId(id);
    try {
      await confirmFeeEntry(id);
      toast.success("已确认到账");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? actionErrorMessage(e) : "确认失败");
    } finally {
      setBusyId(null);
    }
  }

  async function rejectOne(id: string) {
    const reason = await promptDialog({ title: "退回实收登记", description: "退回后该笔登记会被删除，登记人会收到通知并按实际到账重新登记。", label: "退回原因", placeholder: "如：银行流水未见此笔款项", confirmText: "退回", danger: true, required: true });
    if (!reason) return;
    setBusyId(id);
    try {
      await rejectFeeEntry(id, reason);
      toast.success("已退回");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? actionErrorMessage(e) : "退回失败");
    } finally {
      setBusyId(null);
    }
  }

  useTopbarAction(canWrite ? { label: "登记收付", onClick: () => setRecordOpen(true) } : null, [canWrite]);

  const filtered = useMemo(() => {
    const since = range ? Date.now() - Number(range) * 86_400_000 : 0;
    const kw = q.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!typeFilter || e.type === typeFilter) &&
        (!since || new Date(e.occurredAt).getTime() >= since) &&
        (!kw || `${e.matter.title} ${e.matter.internalCode} ${e.payerOrPayee ?? ""} ${e.note ?? ""}`.toLowerCase().includes(kw))
    );
  }, [entries, q, range, typeFilter]);

  const now = new Date();
  const nowSh = shParts(now);
  const monthGrowth = stats.lastMonthReceived > 0 ? Math.round(((stats.monthlyReceived - stats.lastMonthReceived) / stats.lastMonthReceived) * 100) : null;

  const worst = aging.worst;
  const pendingInvoices = invoiceRequests.filter((r) => r.status === "PENDING" || r.status === "APPROVED");
  const invoiceRows = [...pendingInvoices, ...invoiceRequests.filter((r) => r.status === "ISSUED")].slice(0, 4);
  // 待确认实收走独立查询（不受流水条数上限影响），旧数据兜底用流水里的 PENDING
  const pendingReceipts = pendingEntries ?? entries.filter((e) => e.type === "RECEIVED" && e.confirmState === "PENDING");
  const reconciliationById = new Map(invoiceReconciliation.map((row) => [row.id, row]));
  const issuedUnpaid = invoiceRequests.filter((r) => r.status === "ISSUED").map((r) => ({
    ...r,
    reconciliation: reconciliationById.get(r.id) ?? { status: "REVIEW", received: null, outstanding: null, reason: "票款关系待核，当前范围内无法确认" }
  })).filter(r=>r.reconciliation.status!=="SETTLED");
  const overdueRows = aging.items.filter((r) => (r.overdueDays ?? 0) > 0);
  const commissionEntries = commissionRows ?? entries.filter((e) => e.type === "COMMISSION");

  return (
    <div className="mo-finance">
      <PageHeader
        title="财务"
        sub={`${nowSh.y} 年 ${nowSh.m} 月 · 数据截至 ${mmdd(now)} · 金额按财务查看权限范围汇总`}
        actions={
          <div className="flex gap-2">{canInternalRead ? <Link href="/finance/internal" className="btn btn-secondary btn-sm">内部经营财务</Link> : null}<Link href="/finance/reconciliation" className="btn btn-secondary btn-sm">应收与收款分配</Link>{canExport ? (
            <a href={`/api/finance/export${range ? `?days=${range}` : ""}`} className="btn btn-secondary btn-sm">导出流水</a>
          ) : null}</div>
        }
      />

      {canInternalRead ? <div className="card flex flex-wrap items-center justify-between gap-3 border-[var(--teal-line)] bg-[var(--teal-soft)] px-4 py-3.5"><div><div className="text-[13px] font-[600] text-[var(--teal-deep)]">内部经营财务工作区</div><div className="mt-1 text-[11.5px] text-[var(--t-secondary)]">管理银行来源、人工认领、分成快照与月结交付；不改变案件应收和开票口径。</div></div><Link href="/finance/internal" className="btn btn-primary btn-sm">进入工作区 →</Link></div> : null}

      <div className="kpi-grid">
        <MetricCard
          label={stats.ledgerReady?"本月律师费实收":"本月实收"}
          value={yuan(stats.monthlyReceived)}
          trend={monthGrowth === null ? null : { tone: monthGrowth >= 0 ? "up" : "down", text: `${monthGrowth >= 0 ? "↑" : "↓"} ${Math.abs(monthGrowth)}%` }}
          sub={`已确认 ${stats.monthConfirmedCount} 笔${stats.monthRefundAmount ? ` · 含退款冲正 -${yuan(stats.monthRefundAmount)}` : ""}${stats.monthPendingCount ? ` · 待确认 ${stats.monthPendingCount} 笔 ${yuan(stats.monthPendingAmount)}（未计入）` : ""}`}
        />
        <MetricCard
          label="应收余额"
          value={yuan(aging.totalOutstanding)}
          trend={stats.writeOffRate != null ? { tone: "info", text: `本月新应收已核销 ${stats.writeOffRate}%` } : { tone: "info", text: `${aging.matterCount} 个案件` }}
          sub={`按应收单核销口径 · 含未到期 ${yuan(aging.buckets[0].amount)}${stats.writeOffRate != null ? ` · ${aging.matterCount} 个案件` : ""}`}
        />
        <MetricCard
          label="逾期未回款"
          hot={aging.overdueAmount > 0}
          value={yuan(aging.overdueAmount)}
          trend={worst ? { tone: "down", text: `超期 ${worst.overdueDays} 天` } : { tone: "up", text: "无逾期" }}
          sub={worst ? `${worst.matter.clientName ?? worst.matter.title} · ${worst.title} ${worst.dueDate ? `${mmdd(worst.dueDate)} 到期` : ""}` : "已明确到期日的应收暂无逾期"}
        />
        <MetricCard label={stats.ledgerReady?"本年律师费实收":"本年已确认收款"} value={yuan(stats.yearlyReceived)} sub={stats.ledgerReady?"已确认净实收；不含代收及代垫回收":"当前账面收款"} />
      </div>

      <div className="fin-tabs">
        <Segmented
          items={[
            { key: "ledger", label: "收付流水" },
            { key: "invoices", label: "开票管理", count: stats.pendingInvoiceCount || null },
            { key: "commission", label: "律师分成" },
            { key: "aging", label: "应收账龄", count: overdueRows.length || null }
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === "ledger" ? (
        <>
          <div className="fin-grid">
            <RevenueChart data={monthly} height={190} />
            <div className="card">
              <div className="panel-head">
                <div className="panel-title">
                  <FileText className="ic" strokeWidth={1.8} />
                  开票进度
                </div>
                <button type="button" className="t-sm t-mute" onClick={() => setTab("invoices")}>开票管理 →</button>
              </div>
              {invoiceRows.length === 0 && overdueRows.length === 0 ? (
                <div className="empty mo-empty-compact"><div className="mo-empty-title">暂无开票申请</div></div>
              ) : (
                <>
                  {invoiceRows.slice(0, overdueRows.length ? 3 : 4).map((r) => (
                    <div key={r.id} className="inv-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="inv-title truncate">{r.matter?.title ?? r.buyerName ?? "无关联案件开票"}{r.title ? ` · ${r.title}` : ""}</div>
                        <div className="inv-meta truncate">
                          {yuan(r.amount)} · {r.invoiceType === "SPECIAL" ? "专票" : "普票"} · {r.status === "ISSUED" ? `${r.issuedAt ? mmdd(r.issuedAt) : ""} 已开出${r.invoiceNo ? ` ${r.invoiceNo}` : ""}` : invoiceRequestStatusLabel[r.status]}
                        </div>
                      </div>
                      <span className={cn("badge", r.status === "ISSUED" ? "b-green" : r.status === "REJECTED" ? "b-outline-red" : "b-teal")}>{r.status === "ISSUED" ? "已开票" : r.status === "REJECTED" ? "已驳回" : "待处理"}</span>
                    </div>
                  ))}
                  {overdueRows.slice(0, 1).map((r) => (
                    <div key={r.id} className="inv-row" style={{ background: "var(--red-bg)" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="inv-title truncate">{r.matter.clientName ?? r.matter.title} · {r.title}</div>
                        <div className="inv-meta">{yuan(r.outstanding)} · 逾期 {r.overdueDays} 天未回款</div>
                      </div>
                      <button type="button" className="badge b-outline-red" onClick={() => setTab("aging")}>催收跟进</button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {pendingReceipts.length > 0 ? (
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="panel-head flex-wrap">
                <div className="panel-title">
                  <Clock3 className="ic" strokeWidth={1.8} />
                  待确认实收 <span className="mo-count">{pendingReceipts.length}</span>
                  <span className="t-xs t-mute" style={{ fontWeight: 400 }}>
                    合计 {yuan(pendingReceipts.reduce((s, e) => s + e.amount, 0))} · 确认后才计入已实收并派生分成
                  </span>
                </div>
              </div>
              <div className="mo-scroll-x">
                <table className="mo-table" style={{ minWidth: 880, tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 76, paddingLeft: 20 }}>日期</th>
                      <th>案件 / 事项</th>
                      <th style={{ width: 170 }}>付款方</th>
                      <th style={{ width: 132 }} className="num">登记金额</th>
                      <th style={{ width: 72 }}>登记人</th>
                      <th style={{ width: canConfirmReceipt ? 150 : 84 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingReceipts.map((e) => (
                      <tr key={e.id} data-spine="amber">
                        <td className="mono t-sm whitespace-nowrap" style={{ paddingLeft: 20 }}>{mmdd(e.occurredAt)}</td>
                        <td className="min-w-0">
                          <Link href={matterHref(e.matter)} className="block min-w-0 no-underline hover:text-[var(--teal-deep)]">
                            <div className="fee-matter truncate">{e.matter.title}{e.note ? ` · ${e.note}` : ""}</div>
                            <div className="fee-meta truncate">{e.matter.internalCode}{e.invoiceNo ? ` · 发票 ${e.invoiceNo}` : ""}{e.method ? ` · ${e.method}` : ""}</div>
                          </Link>
                        </td>
                        <td className="t-sm truncate" title={e.payerOrPayee ?? undefined}>{e.payerOrPayee ?? <span className="t-faint">—</span>}</td>
                        <td className="num money whitespace-nowrap in">+{yuan(e.amount, 2)}</td>
                        <td className="t-sm truncate whitespace-nowrap">{e.recordedBy.name}</td>
                        <td>
                          {canConfirmReceipt ? (
                            <div className="flex items-center gap-1.5">
                              <button type="button" className="btn btn-primary btn-sm" disabled={busyId === e.id} onClick={() => void confirmOne(e.id)}>确认到账</button>
                              <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === e.id} onClick={() => void rejectOne(e.id)}>退回</button>
                            </div>
                          ) : (
                            <span className="badge b-amber">待确认到账</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="card" style={{ overflow: "hidden" }}>
            <div className="panel-head flex-wrap">
              <div className="panel-title">
                <DollarSign className="ic" strokeWidth={1.8} />
                收付流水 <span className="mo-count">{filtered.length}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="mo-toolbar-input" style={{ width: 220, height: 30 }}>
                  <Search aria-hidden />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按案件、对方户名搜索" aria-label="搜索流水" />
                </label>
                <FilterSelect label="类型" value={typeFilter} options={(Object.keys(TYPE_META) as Entry["type"][]).map((t) => ({ value: t, label: TYPE_META[t].label }))} onChange={(v) => setTypeFilter(v as Entry["type"] | undefined)} />
                <FilterSelect label="期间" allLabel="全部" value={range} options={[{ value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "365", label: "近一年" }]} onChange={setRange} />
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="empty mo-empty-compact"><div className="mo-empty-title">没有匹配的收付记录</div><div className="mo-empty-desc">调整期间或类型筛选；收付在案件详情或点击「登记收付」录入。</div></div>
            ) : (
              <div className="mo-scroll-x">
                <table className="mo-table" style={{ minWidth: 1000, tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 76, paddingLeft: 20 }}>日期</th>
                      <th>案件 / 事项</th>
                      <th style={{ width: 72 }}>类型</th>
                      <th style={{ width: 170 }}>对方户名</th>
                      <th style={{ width: 132 }} className="num">金额</th>
                      <th style={{ width: 84 }}>方式</th>
                      <th style={{ width: 64 }}>经手</th>
                      <th style={{ width: 80 }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => {
                      const meta = TYPE_META[e.type];
                      return (
                        <tr key={e.id} data-spine={e.type === "RECEIVED" ? "green" : e.type === "REFUND" ? "red" : e.type === "RECEIVABLE" ? "amber" : "slate"}>
                          <td className="mono t-sm whitespace-nowrap" style={{ paddingLeft: 20 }}>{mmdd(e.occurredAt)}</td>
                          <td className="min-w-0">
                            <Link href={matterHref(e.matter)} className="block min-w-0 no-underline hover:text-[var(--teal-deep)]">
                              <div className="fee-matter truncate">{e.matter.title}{e.note ? ` · ${e.note}` : ""}</div>
                              <div className="fee-meta truncate">{e.matter.internalCode}{e.moneyKind ? ` · ${moneyKindLabels[e.moneyKind]}` : ""}{e.invoiceNo ? ` · 发票 ${e.invoiceNo}` : ""}{e.beneficiaryUser ? ` · 分成给 ${e.beneficiaryUser.name}` : ""}</div>
                            </Link>
                          </td>
                          <td><span className={cn("badge", meta.badge)}>{meta.label}</span></td>
                          <td className="t-sm truncate" title={e.payerOrPayee ?? undefined}>{e.payerOrPayee ?? <span className="t-faint">—</span>}</td>
                          <td className={cn("num money whitespace-nowrap", meta.cls)}>{meta.sign}{yuan(e.amount, 2)}</td>
                          <td className="t-sm truncate whitespace-nowrap">{e.method ?? <span className="t-faint">—</span>}</td>
                          <td className="t-sm truncate whitespace-nowrap">{e.recordedBy.name}</td>
                          <td>
                            {e.type === "RECEIVED" && e.confirmState === "PENDING" ? (
                              <span className="badge b-amber" title="已登记，等待财务管理人员确认到账">待确认</span>
                            ) : stats.ledgerReady ? (
                              <span className="badge b-green" title="已入账记录不可直接删除">已入账</span>
                            ) : e.confirmed ? (
                              <span className="badge b-green" title="关联已签署合同或已登记发票号，不可物理删除">受保护</span>
                            ) : (
                              <span className="badge b-white" title="尚未关联已签署合同或发票号">可更正</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="panel-foot t-xs t-mute">{stats.ledgerReady?"待确认实收不计入统计；已入账记录不可直接删除。律师费与代收、代垫回收分别统计。":"已确认记录受保护：关联已签署合同或已登记发票号的收付不可物理删除，更正需走关联冲正并留痕"}</div>
          </div>
        </>
      ) : null}

      {tab === "invoices" ? (
        <div className="card">
          <div className="panel-head">
            <div className="panel-title">
              <FileText className="ic" strokeWidth={1.8} />
              开票管理
            </div>
            <button type="button" onClick={() => setInvoiceCreateOpen(true)} className="btn btn-primary btn-sm">
              <Plus />
              新建开票申请
            </button>
          </div>
          <div className="panel-body">
            <InvoiceManagementSection requests={invoiceRequests} canApprove={canApproveInvoice} />
          </div>
        </div>
      ) : null}

      {tab === "invoices" && issuedUnpaid.length > 0 ? (
        <div className="card" style={{ marginTop: 14, overflow: "hidden" }}>
          <div className="panel-head flex-wrap">
            <div className="panel-title">
              <Clock3 className="ic" strokeWidth={1.8} />
              已开票待收款 / 待核 <span className="mo-count">{issuedUnpaid.length}</span>
              <span className="t-xs t-mute" style={{ fontWeight: 400 }}>
                {stats.ledgerReady?"按发票金额关联；未关联金额不直接等于客户欠款":"部分回款仍保留；票款关系不明确时不认定结清"}
              </span>
            </div>
          </div>
          <div className="mo-scroll-x">
            <table className="mo-table" style={{ minWidth: 820, tableLayout: "fixed" }}>
              <thead>
                <tr>
                  <th style={{ width: 76, paddingLeft: 20 }}>开票日</th>
                  <th>案件 / 抬头</th>
                  <th style={{ width: 190 }}>发票号</th>
                  <th style={{ width: 132 }} className="num">开票金额</th>
                  <th style={{ width: 132 }} className="num">同号已确认款</th>
                  <th style={{ width: 132 }} className="num">待收参考金额</th>
                  <th style={{ width: 240 }}>核对状态</th>
                </tr>
              </thead>
              <tbody>
                {issuedUnpaid.map((r) => (
                  <tr key={r.id} data-spine="amber">
                    <td className="mono t-sm whitespace-nowrap" style={{ paddingLeft: 20 }}>{r.issuedAt ? mmdd(r.issuedAt) : "—"}</td>
                    <td className="min-w-0">
                      <div className="fee-matter truncate">{r.matter?.title ?? "非案件事项"}</div>
                      <div className="fee-meta truncate">{r.buyerName ?? r.title ?? "—"}</div>
                    </td>
                    <td className="mono t-sm truncate">{r.invoiceNo ?? <span className="t-faint">未登记号码</span>}</td>
                    <td className="num money whitespace-nowrap">{yuan(r.amount, 2)}</td>
                    <td className="num money whitespace-nowrap">{r.reconciliation.received === null ? "—" : yuan(r.reconciliation.received, 2)}</td>
                    <td className="num money whitespace-nowrap">{r.reconciliation.outstanding === null ? "待核" : yuan(r.reconciliation.outstanding, 2)}</td>
                    <td className="t-sm">{r.reconciliation.reason ?? (r.reconciliation.status === "PARTIAL" ? "部分关联" : "尚未关联已确认收款")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "commission" ? (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <MetricCard label="我的本月分成" value={yuan(stats.personalMonthly)} sub="本期计提及更正差额；实际支付另行登记" />
            <MetricCard label="我的年度分成" value={yuan(stats.personalYearly)} sub={`${nowSh.y} 年累计`} />
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <div className="panel-head">
              <div className="panel-title">
                <Users className="ic" strokeWidth={1.8} />
                分成流水 <span className="mo-count">{commissionEntries.length}</span>
              </div>
              <span className="t-xs t-mute">分成方案在案件详情「财务明细」中维护</span>
            </div>
            {commissionEntries.length === 0 ? (
              <div className="empty mo-empty-compact"><div className="mo-empty-title">暂无分成记录</div></div>
            ) : (
              <div className="mo-scroll-x">
                <table className="mo-table" style={{ minWidth: 720 }}>
                  <thead><tr><th style={{ paddingLeft: 20 }}>日期</th><th>案件</th><th>受益人</th><th className="num">金额</th><th>备注</th></tr></thead>
                  <tbody>
                    {commissionEntries.map((e) => (
                      <tr key={e.id} data-spine="violet">
                        <td className="mono t-sm" style={{ paddingLeft: 20 }}>{mmdd(e.occurredAt)}</td>
                        <td><Link href={matterHref(e.matter)} className="fee-matter hover:text-[var(--teal-deep)]">{e.matter.title}</Link><div className="fee-meta">{e.matter.internalCode}</div></td>
                        <td className="t-sm">{e.beneficiaryUser?.name ?? "—"}</td>
                        <td className="num money">{yuan(e.commissionAccrued ?? e.amount, 2)}{e.commissionAccrued!==undefined&&<div className="t-xs t-mute">原计提 {yuan(e.amount,2)} · 净支付 {yuan(e.commissionNetPaid??0,2)} · 待扣回 {yuan(e.commissionRecoverable??0,2)}</div>}</td>
                        <td className="t-sm t-mute max-w-[14rem] truncate">{e.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {tab === "aging" ? (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
            {aging.buckets.map((b, i) => (
              <MetricCard key={b.key} label={b.label} hot={i >= 3 && b.amount > 0} value={yuan(b.amount)} sub={`${b.count} 笔`} />
            ))}
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <div className="panel-head">
              <div className="panel-title">
                <Clock3 className="ic" strokeWidth={1.8} />
                未核销应收 <span className="mo-count">{aging.items.length}</span>
              </div>
              <span className="t-xs t-mute">余额 = 应收金额 − 已核销；按到期日排序</span>
            </div>
            {aging.items.length === 0 ? (
              <div className="empty mo-empty-compact"><div className="mo-empty-title">暂无未核销应收</div></div>
            ) : (
              <div className="mo-scroll-x">
                <table className="mo-table" style={{ minWidth: 760 }}>
                  <thead><tr><th style={{ paddingLeft: 20 }}>到期日</th><th>案件 / 应收事项</th><th>客户</th><th className="num">未回款</th><th>账龄</th></tr></thead>
                  <tbody>
                    {aging.items.map((r) => {
                      const d = r.overdueDays ?? 0;
                      return (
                        <tr key={r.id} data-spine={d > 60 ? "red" : d > 0 ? "amber" : "blue"} className={d > 30 ? "row-risk" : undefined}>
                          <td className="mono t-sm" style={{ paddingLeft: 20 }}>{r.dueDate ? mmdd(r.dueDate) : "未约定"}</td>
                          <td><Link href={matterHref(r.matter)} className="fee-matter hover:text-[var(--teal-deep)]">{r.matter.title} · {r.title}</Link><div className="fee-meta">{r.matter.internalCode}</div></td>
                          <td className="t-sm">{r.matter.clientName ?? "—"}</td>
                          <td className={cn("num money", d > 0 && "t-red")}>{yuan(r.outstanding, 2)}</td>
                          <td>{d > 0 ? <span className={cn("badge", d > 30 ? "b-red" : "b-amber")}>逾期 {d} 天</span> : <span className="badge b-white">未到期</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      <InvoiceCreateDialog open={invoiceCreateOpen} onOpenChange={setInvoiceCreateOpen} canCreateUnlinkedInvoice={canApproveInvoice} />
      {canWrite ? <RecordFeeLauncher open={recordOpen} onOpenChange={setRecordOpen} /> : null}
    </div>
  );
}
