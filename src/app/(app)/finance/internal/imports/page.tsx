import Link from "next/link";
import { ArrowLeft, ArrowRight, Database } from "lucide-react";
import { PageHeader } from "@/components/patterns/moan";
import { canManageFinanceImports } from "@/server/finance/internal-imports";
import { listInternalImportBatches, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { ImportWorkspace } from "../_components/import-workspace";

export default async function InternalFinanceImportsPage() {
  const session = await requireInternalFinanceSession();
  const batches = await listInternalImportBatches();
  return (
    <div className="space-y-4">
      <PageHeader title="银行流水与归档" sub="先保留来源证据，再进入认领与经营财务计算。" back={{ href: "/finance/internal", label: "内部财务总览" }} actions={<Link href="/finance/internal/reconciliation" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5">下一步：待认领<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
      <InternalFinanceNav active="imports" />
      <div className="mo-note"><Database className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>归档后原文件进入受保护存储，来源行会生成不可变指纹；页面预览会截断显示对方和摘要，不把完整账户号带到界面。</span><Link href="/finance/internal" className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--teal-deep)] no-underline">返回总览<ArrowLeft className="h-3 w-3" aria-hidden="true" /></Link></div>
      <ImportWorkspace batches={batches} canImport={canManageFinanceImports(session.user)} />
    </div>
  );
}
