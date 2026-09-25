import Link from "next/link";
import { ArrowRight, ClipboardCheck, FileArchive, Landmark, LockKeyhole, UploadCloud, Wallet } from "lucide-react";
import { PageHeader, Panel, ProcedureChain, Tag } from "@/components/patterns/moan";
import { hasCustomPermission } from "@/lib/roles/catalog";
import { currentFinancePeriod, requireInternalFinanceSession } from "@/server/finance/internal-workspaces";
import { getInternalFinanceOverview } from "@/server/finance/internal-finance-workspaces";
import { InternalFinanceNav } from "./_components/internal-finance-nav";

export default async function InternalFinanceOverviewPage() {
  const session = await requireInternalFinanceSession();
  const period = currentFinancePeriod();
  const overview = await getInternalFinanceOverview(period, session.user);
  const status = overview.closeStatus;
  const canImport = session.user.role === "FINANCE" || hasCustomPermission(session.user, "finance.import");
  const canReconcile = hasCustomPermission(session.user, "finance.reconcile");
  const canRules = hasCustomPermission(session.user, "finance.rules");

  return (
    <div className="space-y-4">
      <PageHeader title="内部经营财务" sub={`${period} · 来源、对账、分配与月结在同一条可追溯链路中`} back={{ href: "/finance", label: "返回财务" }} actions={<Link href="/finance/internal/monthly-close" className="btn btn-primary btn-sm inline-flex items-center gap-1.5">查看月结闸门<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
      <InternalFinanceNav active="overview" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewMetric icon={UploadCloud} label="来源归档" value={`${status.sourceFiles} 个文件`} hint={status.sourceKinds.length ? status.sourceKinds.join("、") : "等待首次归档"} tone={status.sourceFiles ? "teal" : "slate"} />
        <OverviewMetric icon={ClipboardCheck} label="待认领" value={`${status.unresolvedCount} 条`} hint={status.unresolvedCount ? "处理后才能进入月结" : "本期没有待处理项"} tone={status.unresolvedCount ? "amber" : "green"} />
        <OverviewMetric icon={Landmark} label="正式计算" value={status.runId ? "已提交" : "未生成"} hint={status.runId ? "结果来自固定来源指纹" : "完成分配后生成"} tone={status.runId ? "green" : "amber"} />
        <OverviewMetric icon={FileArchive} label="月结状态" value={status.ready ? "可交付" : "有阻断项"} hint={status.ready ? "可以生成交付包" : status.blockingWarnings[0] ?? "需要继续核对"} tone={status.ready ? "green" : "amber"} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <OverviewMetric icon={Wallet} label="正式律师费收入" value={overview.officialSnapshot ? `¥${overview.officialSnapshot.feeRevenue}` : "未生成"} hint={overview.officialSnapshot ? "来自已提交分配快照" : "暂无正式计算快照"} tone={overview.officialSnapshot ? "teal" : "slate"} />
        <OverviewMetric icon={Landmark} label="律所留存" value={overview.officialSnapshot ? `¥${overview.officialSnapshot.firmRetained}` : "未生成"} hint="正式快照口径" tone={overview.officialSnapshot ? "teal" : "slate"} />
        <OverviewMetric icon={Wallet} label="律师分配" value={overview.officialSnapshot ? `¥${overview.officialSnapshot.lawyerAllocation}` : "未生成"} hint="正式快照口径" tone={overview.officialSnapshot ? "teal" : "slate"} />
        <OverviewMetric icon={Landmark} label="银行来源入账" value={overview.bank.creditAmount === null ? "未归档" : `¥${overview.bank.creditAmount}`} hint={`${overview.bank.creditRows} 条来源流水；不等同确认收款`} tone={overview.bank.creditAmount === null ? "slate" : "teal"} />
        <OverviewMetric icon={ClipboardCheck} label="已确认关联流水" value={overview.bank.confirmedCreditAmount === null ? "待核对" : `¥${overview.bank.confirmedCreditAmount}`} hint="仅统计已明确关联案件收款的来源流水" tone={overview.bank.confirmedCreditAmount === null ? "slate" : "green"} />
      </div>
      <div className="mo-note"><Landmark className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>银行入账金额是原始流水口径；已确认关联额单独统计。无正式快照或未归档来源时显示“未生成/未归档”，不会用 0 代替未知。</span></div>

      <Panel title="本期工作链" icon={Landmark} extra={<Tag tone="slate">不替代法定财务报表</Tag>}>
        <ProcedureChain nodes={[
          { key: "source", label: "来源归档", state: status.sourceFiles ? "done" : "current", date: status.sourceFiles ? `${status.sourceFiles} 个文件` : "待开始" },
          { key: "reconcile", label: "认领归类", state: status.unresolvedCount === 0 && status.sourceFiles ? "done" : status.sourceFiles ? "risk" : "todo", date: status.unresolvedCount ? `${status.unresolvedCount} 条待处理` : "已清空" },
          { key: "allocation", label: "正式分配", state: status.runId ? "done" : status.unresolvedCount ? "blocked" : "current", date: status.runId ? "已提交" : "等待批次" },
          { key: "close", label: "月结交付", state: status.ready ? "current" : "todo", date: status.ready ? "可生成" : "未就绪" }
        ]} />
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <NextAction href="/finance/internal/imports" icon={UploadCloud} title="归档新资料" description={canImport ? "上传银行流水、工资表或外账资料" : "查看已归档的来源文件"} />
          <NextAction href="/finance/internal/reconciliation" icon={ClipboardCheck} title="处理待认领" description={canReconcile ? "接受建议、改选目标或留下疑点" : "查看来源行和候选建议"} />
          <NextAction href="/finance/internal/monthly-close" icon={FileArchive} title="核对月结" description={canRules ? "查看正式批次、调整与交付文件" : "查看本期月结状态"} />
        </div>
      </Panel>

      <div className="mo-note"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" /><span>内部经营财务和原有案件应收、开票、收款分配是两条边界清晰的工作线。本工作区只展示通过权限校验的来源摘要和计算快照，原始文件不会直接出现在页面上。</span></div>
    </div>
  );
}

function OverviewMetric({ icon: Icon, label, value, hint, tone }: { icon: typeof Landmark; label: string; value: string; hint: string; tone: "teal" | "slate" | "amber" | "green" }) {
  const iconClass = tone === "green" ? "bg-[var(--green-bg)] text-[var(--green)]" : tone === "amber" ? "bg-[var(--amber-bg)] text-[var(--amber)]" : tone === "teal" ? "bg-[var(--teal-soft)] text-[var(--teal-deep)]" : "bg-[var(--bg-sunken)] text-[var(--t-muted)]";
  return <div className="card p-3.5"><div className="flex items-start justify-between gap-3"><span className={`flex h-8 w-8 items-center justify-center rounded-[8px] ${iconClass}`}><Icon className="h-4 w-4" aria-hidden="true" /></span><span className="text-[10.5px] text-[var(--t-faint)]">本期</span></div><div className="mt-3 text-[12px] text-[var(--t-muted)]">{label}</div><div className="mt-1 text-[18px] font-[650] tracking-tight">{value}</div><div className="mt-1 truncate text-[11px] text-[var(--t-muted)]" title={hint}>{hint}</div></div>;
}

function NextAction({ href, icon: Icon, title, description }: { href: string; icon: typeof Landmark; title: string; description: string }) {
  return <Link href={href} className="group flex items-center gap-3 rounded-[9px] border border-[var(--bd-hair)] px-3 py-3 no-underline transition-colors hover:border-[var(--teal-line)] hover:bg-[var(--teal-soft)]"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-[var(--bg-sunken)] text-[var(--teal-deep)] group-hover:bg-white"><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span><span className="min-w-0"><span className="block text-[12.5px] font-[600]">{title}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--t-muted)]">{description}</span></span><ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--t-faint)]" aria-hidden="true" /></Link>;
}
