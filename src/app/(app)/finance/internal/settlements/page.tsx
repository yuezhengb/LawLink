import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowDownToLine, BookOpenCheck } from "lucide-react";
import { PageHeader, Panel, Tag } from "@/components/patterns/moan";
import { scopeFor } from "@/lib/roles/catalog";
import { currentFinancePeriod, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { listAvailableSettlementRuns } from "@/server/finance/personal-settlement";
import { InternalFinanceNav } from "../_components/internal-finance-nav";

export default async function InternalFinanceSettlementsPage() {
  const session = await requireInternalFinanceSession();
  const actor = session.user;
  const canExportAll = actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.export") === "ALL");
  let runs;
  try {
    runs = await listAvailableSettlementRuns(actor);
  } catch {
    redirect("/finance/internal");
  }

  return <div className="space-y-4">
    <PageHeader title="律师个人结算" sub="仅从已提交批次生成；个人范围只能下载本人，财务全权可下载逐人拆分包。" back={{ href: "/finance/internal", label: "内部财务总览" }} />
    <InternalFinanceNav active="settlements" />
    <Panel title="正式结算批次" icon={BookOpenCheck} count={runs.length}>
      {runs.length === 0 ? <div className="text-[12px] text-[var(--t-muted)]">暂无可下载的正式个人结算批次。</div> : <div className="divide-y divide-[var(--bd-hair)]">
        {runs.map((run) => <div key={run.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--teal-soft)] text-[var(--teal-deep)]"><BookOpenCheck className="h-4 w-4" aria-hidden="true" /></div>
          <div className="min-w-[220px] flex-1"><div className="text-[13px] font-[600]">{run.period} · 已提交</div><div className="mt-0.5 font-mono text-[10.5px] text-[var(--t-muted)]">批次 {run.id} · 来源指纹 {run.sourceHash.slice(0, 12)}…</div></div>
          <Tag tone="green">仅正式快照</Tag>
          {canExportAll ? <a className="btn btn-primary btn-sm inline-flex items-center gap-1.5" href={`/api/finance/internal/personal-settlements?runId=${encodeURIComponent(run.id)}&period=${encodeURIComponent(run.period)}&format=zip`}><ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />下载逐人拆分包</a> : <a className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" href={`/api/finance/internal/personal-settlements?runId=${encodeURIComponent(run.id)}&period=${encodeURIComponent(run.period)}`}><ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />下载本人结算</a>}
        </div>)}
      </div>}
    </Panel>
    <div className="mo-note"><BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>每份工作簿只包含对应人员的余额和分配明细，不会在其他律师的文件中夹带同事姓名或案件分配。全所拆分包的访问与下载会写入审计。</span><Link className="ml-auto shrink-0 text-[var(--teal-deep)] no-underline" href={`/finance/internal/monthly-close?period=${currentFinancePeriod()}`}>月结交付</Link></div>
  </div>;
}
