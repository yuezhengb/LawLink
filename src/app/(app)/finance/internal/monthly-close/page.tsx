import Link from "next/link";
import { ArrowLeft, CheckCheck } from "lucide-react";
import { PageHeader } from "@/components/patterns/moan";
import { canManageInternalFinance } from "@/lib/roles/catalog";
import { currentFinancePeriod, getMonthlyCloseWorkspace, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { MonthlyCloseWorkspace } from "../_components/monthly-close-workspace";

export default async function InternalFinanceMonthlyClosePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const session = await requireInternalFinanceSession();
  const params = await searchParams;
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) ? params.period : currentFinancePeriod();
  const data = await getMonthlyCloseWorkspace(period, session.user);
  return (
    <div className="space-y-4">
      <PageHeader title="月结与财务交付" sub={`${period} · 只从 COMMITTED 正式批次生成文件，调整采用追加凭证。`} back={{ href: "/finance/internal", label: "内部财务总览" }} actions={<Link href="/finance/internal/reconciliation" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />回到待认领</Link>} />
      <InternalFinanceNav active="monthly-close" />
      <div className="mo-note"><CheckCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>月结交付包用于律所内部经营核对、工资与会计资料交接，不替代法定会计账簿或外部财务老师的申报口径。</span></div>
      <MonthlyCloseWorkspace data={data} canMaterialize={canManageInternalFinance(session.user, "finance.rules")} canAdjust={canManageInternalFinance(session.user, "finance.adjust")} canExport={canManageInternalFinance(session.user, "finance.export")} />
    </div>
  );
}
