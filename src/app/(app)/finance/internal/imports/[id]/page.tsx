import { PageHeader } from "@/components/patterns/moan";
import { requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { InternalFinanceNav } from "../../_components/internal-finance-nav";
import { ImportSourcePreview } from "../../_components/import-source-preview";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function InternalFinanceImportSourcePage({ params }: { params: Promise<{ id: string }> }) {
  await requireInternalFinanceSession();
  const { id } = await params;
  return (
    <div className="space-y-4">
      <PageHeader title="来源资料查看" sub="仅供财务人员核对原始来源；所有查看行为都会留痕。" back={{ href: "/finance/internal/imports", label: "返回来源归档" }} />
      <InternalFinanceNav active="imports" />
      <ImportSourcePreview batchId={id} />
    </div>
  );
}
