import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeftRight, Filter, UsersRound } from "lucide-react";
import { PageHeader, Panel, Tag } from "@/components/patterns/moan";
import { currentFinancePeriod, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { canReadAllInternalFinance, listFinanceCounterparties } from "@/server/finance/internal-finance-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";

type Params = { period?: string; direction?: string; status?: string; cursor?: string };

function selected(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function amount(value: string): string {
  return `¥${value}`;
}

function nextHref(params: Params, cursor: string): string {
  const search = new URLSearchParams();
  search.set("period", selected(params.period, currentFinancePeriod()));
  if (params.direction) search.set("direction", params.direction);
  if (params.status) search.set("status", params.status);
  search.set("cursor", cursor);
  return `/finance/internal/counterparties?${search.toString()}`;
}

export default async function InternalFinanceCounterpartiesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireInternalFinanceSession();
  if (!canReadAllInternalFinance(session.user)) redirect("/finance/internal");
  const params = await searchParams;
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period ?? "") ? params.period! : currentFinancePeriod();
  const direction = ["CREDIT", "DEBIT", "UNKNOWN"].includes(params.direction ?? "") ? params.direction as "CREDIT" | "DEBIT" | "UNKNOWN" : undefined;
  const status = ["UNRESOLVED", "SUGGESTED", "CONFIRMED", "IGNORED", "SUSPECT", "EXCEPTION"].includes(params.status ?? "") ? params.status as never : undefined;
  const result = await listFinanceCounterparties({ period, direction, status, cursor: params.cursor, pageSize: 50 }, session.user);

  return <div className="space-y-4">
    <PageHeader title="往来单位透视" sub="按银行来源指纹独立统计；名称相同不代表同一主体。" back={{ href: "/finance/internal", label: "内部财务总览" }} />
    <InternalFinanceNav active="counterparties" />
    <Panel title="筛选来源" icon={Filter}>
      <form method="get" className="grid gap-3 sm:grid-cols-[170px_170px_190px_auto] sm:items-end">
        <label className="block space-y-1.5 text-[12px] text-[var(--t-secondary)]"><span>期间</span><input className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2.5 text-[13px]" type="month" name="period" defaultValue={period} /></label>
        <label className="block space-y-1.5 text-[12px] text-[var(--t-secondary)]"><span>收付方向</span><select className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2.5 text-[13px]" name="direction" defaultValue={direction ?? ""}><option value="">全部</option><option value="CREDIT">收入</option><option value="DEBIT">支出</option><option value="UNKNOWN">未识别</option></select></label>
        <label className="block space-y-1.5 text-[12px] text-[var(--t-secondary)]"><span>认领状态</span><select className="ll-form-control h-[34px] w-full rounded-[8px] border border-input bg-card px-2.5 text-[13px]" name="status" defaultValue={status ?? ""}><option value="">全部</option><option value="UNRESOLVED">待处理</option><option value="SUGGESTED">有建议待确认</option><option value="CONFIRMED">已确认关联</option><option value="SUSPECT">疑点</option><option value="EXCEPTION">例外</option><option value="IGNORED">已忽略</option></select></label>
        <button type="submit" className="btn btn-primary btn-sm inline-flex items-center gap-1.5"><Filter className="h-3.5 w-3.5" aria-hidden="true" />应用筛选</button>
      </form>
    </Panel>
    <Panel title="银行流水聚合" icon={UsersRound} count={result.items.length} flush>
      <div className="mo-note mx-4 mt-3"><ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>金额来自已归档的银行来源行，不等同财务确认收入。已确认关联、待认领分列；不显示账号和摘要。</span></div>
      {result.items.length === 0 ? <div className="p-6 text-center text-[12px] text-[var(--t-muted)]">该期间没有匹配筛选条件的往来单位来源行。</div> : <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-[12px]">
          <thead className="bg-[var(--bg-sunken)] text-[var(--t-muted)]"><tr><th className="px-4 py-2.5 font-[550]">对方（来源指纹）</th><th className="px-3 py-2.5 font-[550]">银行入账来源额</th><th className="px-3 py-2.5 font-[550]">银行支出来源额</th><th className="px-3 py-2.5 font-[550]">已确认关联流水</th><th className="px-3 py-2.5 font-[550]">待认领收入</th></tr></thead>
          <tbody className="divide-y divide-[var(--bd-hair)]">{result.items.map((item) => <tr key={item.digest}>
            <td className="px-4 py-3"><div className="font-[550]">{item.display || "未命名往来单位"}</div><div className="mt-0.5 font-mono text-[10px] text-[var(--t-faint)]">{item.digest.slice(0, 12)}…</div></td>
            <td className="px-3 py-3"><div>{amount(item.creditAmount)}</div><div className="text-[10.5px] text-[var(--t-muted)]">{item.creditRows} 笔来源</div></td>
            <td className="px-3 py-3"><div>{amount(item.debitAmount)}</div><div className="text-[10.5px] text-[var(--t-muted)]">{item.debitRows} 笔来源</div></td>
            <td className="px-3 py-3"><Tag tone="green">{item.confirmedCreditRows} 笔 · {amount(item.confirmedCreditAmount)}</Tag></td>
            <td className="px-3 py-3"><Tag tone={item.unclaimedCreditRows ? "amber" : "slate"}>{item.unclaimedCreditRows} 笔 · {amount(item.unclaimedCreditAmount)}</Tag></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {result.hasMore && result.nextCursor ? <div className="flex justify-end border-t border-[var(--bd-hair)] p-3"><Link className="btn btn-secondary btn-sm" href={nextHref({ ...params, period }, result.nextCursor)}>下一页</Link></div> : null}
    </Panel>
  </div>;
}
