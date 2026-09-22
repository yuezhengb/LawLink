import { getSession } from "@/lib/auth/session";
import {
  listAllFeeEntries,
  listPendingReceipts,
  getFinanceKpis,
  getMonthlyRevenue,
  getPersonalRevenue
} from "@/server/finance/actions";
import { listInvoiceRequests, getInvoiceStats } from "@/server/invoices/actions";
import { getInvoiceReconciliation } from "@/server/finance/invoice-reconciliation";
import { getReceivablesAging } from "@/server/finance/aging";
import { hasCustomPermission } from "@/lib/roles/catalog";
import { canReadInternalFinance } from "@/server/finance/internal-workspaces";
import { canConfirmReceipt, isManager } from "@/lib/permissions";
import { FinanceViewV4 } from "./_components/finance-view-v4";

export default async function FinancePage() {
  const session = await getSession();
  const userId = session!.user.id;

  const [entries, pending, commissions, kpis, monthly, personal, invoiceRequests, invoiceStats, aging, invoiceReconciliation] = await Promise.all([
    listAllFeeEntries({ limit: 500 }),
    listPendingReceipts(),
    listAllFeeEntries({ type: "COMMISSION", limit: 500 }),
    getFinanceKpis(),
    getMonthlyRevenue(12),
    getPersonalRevenue(userId),
    listInvoiceRequests(),
    getInvoiceStats(),
    getReceivablesAging(),
    getInvoiceReconciliation()
  ]);

  const { monthlyReceived, monthlyReceivable, lastMonthReceived, yearlyReceived, yearlyReceivable, monthConfirmedCount, monthPendingCount, monthPendingAmount, monthRefundAmount, writeOffRate } = kpis;

  return (
    <FinanceViewV4
      entries={entries.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        confirmed: Boolean(entry.billing?.signedAt || entry.invoiceNo)
      }))}
      pendingEntries={pending.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        confirmed: Boolean(entry.billing?.signedAt || entry.invoiceNo)
      }))}
      commissionEntries={commissions.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        confirmed: Boolean(entry.billing?.signedAt || entry.invoiceNo)
      }))}
      monthly={monthly.slice(-6)}
      aging={aging}
      invoiceReconciliation={invoiceReconciliation}
      canInternalRead={canReadInternalFinance(session!.user)}
      canExport={hasCustomPermission(session!.user, "reports.export")}
      canWrite={hasCustomPermission(session!.user, "finance.write")}
      canConfirmReceipt={canConfirmReceipt(session!.user)}
      stats={{
        ledgerReady:kpis.ledgerReady,
        monthlyReceived,
        monthlyReceivable,
        yearlyReceived,
        yearlyReceivable,
        lastMonthReceived,
        personalMonthly: personal.monthlyCommission,
        personalYearly: personal.yearlyCommission,
        monthlyIssued: invoiceStats.monthlyIssued,
        pendingInvoiceCount: invoiceStats.pendingCount,
        monthConfirmedCount,
        monthPendingCount,
        monthPendingAmount,
        monthRefundAmount,
        writeOffRate
      }}
      invoiceRequests={invoiceRequests}
      canApproveInvoice={
        session!.user.role === "FINANCE" ||
        isManager(session!.user)
      }
    />
  );
}
