import Link from "next/link";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/patterns/moan";
import { scopeFor } from "@/lib/roles/catalog";
import { currentFinancePeriod, getInternalReconciliationQueue, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { ReconciliationWorkspace } from "../_components/reconciliation-workspace";

export default async function InternalFinanceReconciliationPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const session = await requireInternalFinanceSession();
  const params = await searchParams;
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) ? params.period : currentFinancePeriod();
  const queue = await getInternalReconciliationQueue(period, session.user);
  const canReconcile = session.user.role === "FINANCE" || (session.user.role === "CUSTOM" && scopeFor(session.user, "finance.reconcile") === "ALL");
  return (
    <div className="space-y-4">
      <PageHeader title="待办认领与归类" sub={`${period} · 依据金额、日期与外部引用生成建议，最终决定由人工留痕。`} back={{ href: "/finance/internal", label: "内部财务总览" }} actions={<Link href="/finance/internal/ledger" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5">下一步：看分成<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
      <InternalFinanceNav active="reconciliation" />
      <div className="mo-note"><ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>只允许把来源行认领到“已确认的律师费收款”。已确认、已忽略和疑点决定都会追加审计记录，原来源行不被改写。</span></div>
      <ReconciliationWorkspace queue={queue} period={period} canReconcile={canReconcile} />
    </div>
  );
}
