"use client";

import { useState } from "react";
import Link from "next/link";
import { BarChart3, Download, Landmark, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Segmented, Tag } from "@/components/patterns/moan";
import type { InternalLedgerView } from "./types";

type LedgerTab = "persons" | "projects" | "firm";

function money(value: string | null): string {
  if (value === null) return "待核对";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `¥${parsed.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : value;
}

function mask(value: string): string {
  return value.length > 8 ? `****${value.slice(-6)}` : value;
}

export function LedgerWorkspace({ view, canExport = false, period, initialTab = "persons" }: { view: InternalLedgerView; canExport?: boolean; period?: string; initialTab?: LedgerTab }) {
  const [tab, setTab] = useState<LedgerTab>(initialTab);
  const hasRun = Boolean(view.calculationRunId) || view.persons.length > 0 || view.projects.length > 0 || Boolean(view.firm);
  const effectivePeriod = period ?? (view.periodStart ? view.periodStart.slice(0, 7) : "");
  const exportHref = effectivePeriod ? `/api/finance/internal/export?periodStart=${encodeURIComponent(`${effectivePeriod}-01`)}&periodEnd=${encodeURIComponent(nextMonth(effectivePeriod))}&groupBy=ALL` : "/api/finance/internal/export";

  if (!hasRun) {
    return (
      <Panel title="分成与经营报表" icon={BarChart3}>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Landmark className="h-8 w-8 text-[var(--t-faint)]" aria-hidden="true" />
          <div className="mt-3 text-[13px] font-[600]">暂无已提交的财务计算批次</div>
          <div className="mt-1.5 max-w-[460px] text-[12px] leading-relaxed text-[var(--t-muted)]">完成来源归档、待认领处理和分配预览后，正式提交的快照会在这里生成。页面不会用估算金额代替正式结果。</div>
          <Link href="/finance/internal/reconciliation" className="btn btn-secondary btn-sm mt-4">先处理待认领</Link>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="分成与经营报表"
      icon={BarChart3}
      extra={<div className="flex items-center gap-2">{view.calculationRunId ? <Tag tone="teal" title={view.calculationRunId}>快照 {mask(view.calculationRunId)}</Tag> : null}{canExport ? <Button asChild size="sm" variant="secondary"><a href={exportHref}><Download aria-hidden="true" />导出本期</a></Button> : null}</div>}
    >
      <Segmented items={[{ key: "persons", label: "人员内账" }, { key: "projects", label: "客户项目归属", count: view.projects.length || null }, { key: "firm", label: "律所经营成果" }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === "persons" ? <PersonTable view={view} /> : tab === "projects" ? <ProjectTable view={view} /> : <FirmCard view={view} />}</div>
    </Panel>
  );
}

function PersonTable({ view }: { view: InternalLedgerView }) {
  const balances = new Map((view.personalBalances ?? []).map((item) => [item.userId, item]));
  if (view.persons.length === 0) return <EmptyTable text="本批次没有人员分配行" />;
  return (
    <div className="overflow-x-auto rounded-[8px] border border-[var(--bd-subtle)]">
      <table className="mo-table min-w-[900px]">
        <thead><tr><th>人员</th><th className="text-right">总收入</th><th className="text-right">渠道</th><th className="text-right">律所</th><th className="text-right">案源</th><th className="text-right">承办</th><th className="text-right">协办</th><th className="text-right">可分配余额</th><th className="text-right">预存保障</th><th className="text-right">保障缺口</th></tr></thead>
        <tbody>{view.persons.map((person) => {
          const balance = person.userId ? balances.get(person.userId) : undefined;
          return <tr key={person.userId ?? "unassigned"}><td><div className="font-[550]">{person.userName}</div><div className="font-mono text-[10px] text-[var(--t-faint)]">{person.userId ? mask(person.userId) : "未指定人员"}</div></td><td className="text-right font-mono">{money(person.grossIncome)}</td><td className="text-right font-mono">{money(person.channelAmount)}</td><td className="text-right font-mono">{money(person.firmAmount)}</td><td className="text-right font-mono">{money(person.sourceAmount)}</td><td className="text-right font-mono">{money(person.handlingAmount)}</td><td className="text-right font-mono">{money(person.coAmount)}</td><td className="text-right font-mono">{balance ? money(balance.distributableEnd) : "—"}</td><td className="text-right font-mono">{balance ? money(balance.selfFundingReserveEnd) : "—"}</td><td className="text-right font-mono">{balance ? money(balance.reserveGap) : "—"}</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function ProjectTable({ view }: { view: InternalLedgerView }) {
  if (view.projects.length === 0) return <EmptyTable text="本批次没有客户项目归属行" />;
  return (
    <div className="space-y-2.5">
      {view.projects.map((project) => <div key={project.matterId} className="rounded-[8px] border border-[var(--bd-hair)] px-3.5 py-3"><div className="flex flex-wrap items-baseline justify-between gap-2"><div><span className="font-mono text-[11px] text-[var(--t-muted)]">{project.matterCode || mask(project.matterId)}</span><span className="ml-2 text-[13px] font-[600]">{project.matterTitle || "未命名项目"}</span></div><span className="text-[11px] text-[var(--t-faint)]">客户引用已掩码</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <ProjectMetric label="案件标的额" value={project.claimAmount} missing="未录入" />
          <ProjectMetric label="现行签约律师费" value={project.signedContractAmount} missing="未登记" />
          <ProjectMetric label="累计已开票净额" value={project.issuedInvoiceNetAmount} />
          <ProjectMetric label="累计确认净收款" value={project.confirmedNetReceiptAmount} />
          <ProjectMetric label="本期分配净额（含退款）" value={project.periodAllocationAmount} />
        </div>
        <div className="mt-3 overflow-x-auto"><table className="mo-table min-w-[900px] text-[11.5px]"><thead><tr><th>来源类型</th><th>发生日期</th><th>付款引用</th><th>退款关联</th><th className="text-right">本期金额</th><th className="text-right">渠道</th><th className="text-right">律所</th><th className="text-right">案源</th><th className="text-right">承办</th><th className="text-right">协办</th></tr></thead><tbody>{project.lines.map((line) => <tr key={`${line.sourceKind}:${line.refundLinkId ?? line.sourcePaymentId}`}><td>{line.sourceKind === "REFUND" ? "退款冲回" : "律师费收款"}</td><td className="font-mono">{line.sourceOccurredAt.slice(0, 10)}</td><td className="font-mono">{mask(line.sourcePaymentId)}</td><td className="font-mono">{line.refundLinkId ? mask(line.refundLinkId) : "—"}</td><td className="text-right font-mono">{money(line.grossAmount)}</td><td className="text-right font-mono">{money(line.channelAmount)}</td><td className="text-right font-mono">{money(line.firmAmount)}</td><td className="text-right font-mono">{money(line.sourceAmount)}</td><td className="text-right font-mono">{money(line.handlingAmount)}</td><td className="text-right font-mono">{money(line.coAmount)}</td></tr>)}</tbody></table></div>
      </div>)}
    </div>
  );
}

function ProjectMetric({ label, value, missing }: { label: string; value: string | null; missing?: string }) {
  return <div className="rounded-[8px] border border-[var(--bd-hair)] bg-[var(--bg-sunken)] px-3 py-2.5"><div className="text-[11.5px] text-[var(--t-muted)]">{label}</div><div className="mt-1 font-mono text-[13px] font-[600]">{value === null ? missing : money(value)}</div></div>;
}

function FirmCard({ view }: { view: InternalLedgerView }) {
  if (!view.firm) return <EmptyTable text="本批次没有律所经营成果" />;
  const values: Array<[string, string | null]> = [
    ["律师费收入", view.firm.feeRevenue],
    ["渠道成本", view.firm.channelAmount],
    ["律所留存", view.firm.firmAmount],
    ["律师分配", view.firm.lawyerAmount],
    ["经营成果", view.firm.operatingResult]
  ];
  const costs = view.firm.costBreakdown;
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{values.map(([label, value], index) => <div key={label} className={index === values.length - 1 ? "rounded-[10px] border border-[var(--teal-line)] bg-[var(--teal-soft)] p-3.5" : "rounded-[10px] border border-[var(--bd-hair)] bg-[var(--bg-sunken)] p-3.5"}><div className="text-[11.5px] text-[var(--t-muted)]">{label}</div><div className="mt-2 font-mono text-[18px] font-[650] tracking-tight">{money(value)}</div></div>)}</div>
    {costs ? <div className="rounded-[10px] border border-[var(--bd-hair)] px-3.5 py-3"><h3 className="text-[12px] font-[650]">律所实际承担成本</h3><div className="mt-2 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">{[["工资", costs.salary], ["社保", costs.social], ["公积金", costs.fund], ["房租", costs.rent], ["办公", costs.office], ["流转税费", costs.turnoverTax], ["其他", costs.other]].map(([label, amount]) => <div key={label} className="flex justify-between gap-2"><span className="text-[var(--t-muted)]">{label}</span><span className="font-mono">{money(amount)}</span></div>)}</div></div> : <p className="text-[11.5px] text-[var(--t-muted)]">成本构成待财务核对。</p>}
  </div>;
}

function EmptyTable({ text }: { text: string }) {
  return <div className="flex flex-col items-center py-10 text-center text-[12px] text-[var(--t-muted)]"><UsersRound className="h-6 w-6 text-[var(--t-faint)]" aria-hidden="true" /><span className="mt-2">{text}</span></div>;
}

function nextMonth(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
}
