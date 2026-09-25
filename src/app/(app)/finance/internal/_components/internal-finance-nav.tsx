import Link from "next/link";
import { ArrowDownToLine, BarChart3, Bell, BookOpenCheck, CircleDollarSign, ClipboardCheck, FileArchive, Gauge, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";

export type InternalFinanceNavKey = "overview" | "imports" | "reconciliation" | "counterparties" | "ledger" | "reports" | "settlements" | "notifications" | "monthly-close";

const items: Array<{ key: InternalFinanceNavKey; label: string; description: string; href: string; icon: typeof Gauge }> = [
  { key: "overview", label: "财务总览", description: "本期闭环状态", href: "/finance/internal", icon: Gauge },
  { key: "imports", label: "银行流水与归档", description: "导入、留痕、下载", href: "/finance/internal/imports", icon: ArrowDownToLine },
  { key: "reconciliation", label: "待办认领与归类", description: "建议、确认、疑点", href: "/finance/internal/reconciliation", icon: ClipboardCheck },
  { key: "counterparties", label: "往来单位透视", description: "来源指纹、收付与认领", href: "/finance/internal/counterparties", icon: UsersRound },
  { key: "ledger", label: "分成与个人内账", description: "人员、项目、规则", href: "/finance/internal/ledger", icon: CircleDollarSign },
  { key: "reports", label: "报表与核对", description: "经营成果与导出", href: "/finance/internal/ledger?view=reports", icon: BarChart3 },
  { key: "settlements", label: "律师个人结算", description: "个人工作簿与受限交付", href: "/finance/internal/settlements", icon: BookOpenCheck },
  { key: "notifications", label: "财务通知", description: "企微摘要预览与确认", href: "/finance/internal/notifications", icon: Bell },
  { key: "monthly-close", label: "月结与财务交付", description: "封账、调整、交付", href: "/finance/internal/monthly-close", icon: FileArchive }
];

export function InternalFinanceNav({ active }: { active: InternalFinanceNavKey }) {
  return (
    <nav aria-label="内部财务工作区" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(({ key, label, description, href, icon: Icon }) => (
        <Link
          key={key}
          href={href}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "group flex min-h-[66px] items-center gap-3 rounded-[10px] border px-3.5 py-3 no-underline transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]",
            active === key
              ? "border-[var(--teal-line)] bg-[var(--teal-soft)] shadow-[var(--sh-card)]"
              : "border-[var(--bd-hair)] bg-card hover:border-[var(--bd-default)] hover:bg-[var(--bg-hover)]"
          )}
        >
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]", active === key ? "bg-white text-[var(--teal-deep)]" : "bg-[var(--bg-sunken)] text-[var(--t-muted)] group-hover:text-[var(--teal-deep)]")}>
            <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className={cn("block truncate text-[13px] font-[600]", active === key ? "text-[var(--teal-deep)]" : "text-foreground")}>{label}</span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--t-muted)]">{description}</span>
          </span>
          {key === "ledger" ? <BookOpenCheck className="ml-auto hidden h-3.5 w-3.5 text-[var(--t-faint)] sm:block" aria-hidden="true" /> : key === "reports" ? <BarChart3 className="ml-auto hidden h-3.5 w-3.5 text-[var(--t-faint)] sm:block" aria-hidden="true" /> : null}
        </Link>
      ))}
    </nav>
  );
}
