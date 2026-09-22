import Link from "next/link";
import { ArrowRight, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/patterns/moan";
import { canManageInternalFinance } from "@/lib/roles/catalog";
import { listInternalRuleSets, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { RulesWorkspace } from "../_components/rules-workspace";

export default async function InternalFinanceRulesPage() {
  const session = await requireInternalFinanceSession();
  const ruleSets = await listInternalRuleSets();
  return (
    <div className="space-y-4">
      <PageHeader title="规则与案件画像" sub="用版本化规则描述内部约定，让每次分配都能回到生效日期和来源说明。" back={{ href: "/finance/internal", label: "内部财务总览" }} actions={<Link href="/finance/internal/ledger" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5">查看分配结果<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
      <InternalFinanceNav active="ledger" />
      <div className="mo-note"><Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>规则发布是全所口径动作。草稿可以继续调整，已发布版本不可修改；案件画像会在案件范围内单独保存来源、参与人员和生效规则集。</span></div>
      <RulesWorkspace ruleSets={ruleSets} canManageRules={canManageInternalFinance(session.user, "finance.rules")} />
    </div>
  );
}
