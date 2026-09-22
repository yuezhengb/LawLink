import Link from "next/link";
import { ArrowRight, BookOpenCheck, Download } from "lucide-react";
import { PageHeader } from "@/components/patterns/moan";
import { hasCustomPermission } from "@/lib/roles/catalog";
import { currentFinancePeriod, getInternalLedgerView, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { LedgerWorkspace } from "../_components/ledger-workspace";

export default async function InternalFinanceLedgerPage({ searchParams }: { searchParams: Promise<{ period?: string; view?: string }> }) {
  const session = await requireInternalFinanceSession();
  const params = await searchParams;
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) ? params.period : currentFinancePeriod();
  const initialTab = params.view === "reports" ? "firm" : "persons";
  const view = await getInternalLedgerView(period, session.user);
  return (
    <div className="space-y-4">
      <PageHeader title="分成与个人内账" sub={`${period} · 人员、客户项目和律所经营成果都来自同一正式快照。`} back={{ href: "/finance/internal", label: "内部财务总览" }} actions={<div className="flex flex-wrap gap-2"><Link href="/finance/internal/rules" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"><BookOpenCheck className="h-3.5 w-3.5" aria-hidden="true" />规则与案件画像</Link><Link href="/finance/internal/monthly-close" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5">月结交付<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link></div>} />
      <InternalFinanceNav active={initialTab === "firm" ? "reports" : "ledger"} />
      <div className="mo-note"><Download className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>人员内账把“可分配余额、预存保障、保障缺口”分开显示；没有正式批次时不展示估算金额。来源引用和客户引用在导出中保持掩码。</span></div>
      <LedgerWorkspace view={view} period={period} initialTab={initialTab} canExport={hasCustomPermission(session.user, "finance.export")} />
    </div>
  );
}
