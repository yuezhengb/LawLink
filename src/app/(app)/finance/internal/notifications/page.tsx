import { PageHeader } from "@/components/patterns/moan";
import { scopeFor } from "@/lib/roles/catalog";
import { requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { getFinanceWecomSettings } from "@/server/finance/finance-wecom";
import { InternalFinanceNav } from "../_components/internal-finance-nav";
import { FinanceWecomWorkspace } from "../_components/finance-wecom-settings";

export default async function InternalFinanceNotificationsPage() {
  const session = await requireInternalFinanceSession();
  const actor = session.user;
  const canManage = actor.role === "FINANCE" || (actor.role === "CUSTOM" && scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.read") === "ALL" && (scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.rules") === "ALL" || scopeFor({ role: actor.role, rolePermissions: actor.rolePermissions ?? undefined }, "finance.adjust") === "ALL"));
  const initialSettings = canManage ? await getFinanceWecomSettings(actor) : { enabled: false, groupLabel: "", hasWebhook: false };

  return <div className="space-y-4">
    <PageHeader title="财务通知" sub="先查看摘要，再逐次确认；系统不会定时或自动群发。" back={{ href: "/finance/internal", label: "内部财务总览" }} />
    <InternalFinanceNav active="notifications" />
    <FinanceWecomWorkspace initialSettings={initialSettings} canManage={canManage} />
  </div>;
}
