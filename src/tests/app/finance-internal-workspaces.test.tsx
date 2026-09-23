import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportWorkspace } from "@/app/(app)/finance/internal/_components/import-workspace";
import { LedgerWorkspace } from "@/app/(app)/finance/internal/_components/ledger-workspace";
import { MonthlyCloseWorkspace } from "@/app/(app)/finance/internal/_components/monthly-close-workspace";
import { ReconciliationWorkspace } from "@/app/(app)/finance/internal/_components/reconciliation-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => cleanup());

describe("内部财务工作区", () => {
  it("没有导入权限时不渲染上传按钮", () => {
    render(<ImportWorkspace batches={[]} reviewRecords={[]} reviewUsers={[]} canImport={false} canReview={false} />);
    expect(screen.queryByRole("button", { name: "上传并预览" })).not.toBeInTheDocument();
  });

  it("类型化财务资料按原文件行号人工关联，不显示姓名字段", () => {
    render(<ImportWorkspace
      batches={[]}
      reviewRecords={[{
        id: "synthetic-record", batchId: "synthetic-batch", batchFileName: "synthetic-payroll.csv", sourceRow: 2,
        kind: "PAYROLL", period: "2026-08", asOfDay: null, roleLabel: null, statement: null, item: null,
        amount: null, declaredSalary: "15000.00", actualCashPaid: "12000.00", selfCostDue: "800.00",
        resolvedUserId: null, resolvedUserName: null, reviewStatus: "NEEDS_REVIEW"
      }]}
      reviewUsers={[{ id: "synthetic-user", name: "合成人员", role: "LAWYER" }]}
      canImport={false}
      canReview
    />);

    expect(screen.getByText("工资表 · 第 2 行 · 2026-08")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "第 2 行关联人员" })).toHaveTextContent("合成人员");
    expect(screen.queryByRole("columnheader", { name: /姓名/ })).not.toBeInTheDocument();
  });

  it("没有正式批次时不展示假金额", () => {
    render(<LedgerWorkspace view={{ persons: [], projects: [], firm: null }} />);
    expect(screen.getByText("暂无已提交的财务计算批次")).toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });

  it("支出退款行提供人工关联入口，不显示收入认领按钮", () => {
    render(<ReconciliationWorkspace period="2026-08" canReconcile queue={{ total: 1, items: [{
      id: "synthetic-refund-case", sourceRowId: "synthetic-refund-source", status: "UNRESOLVED",
      row: {
        sourceKind: "BANK_STATEMENT", sourceBatchId: "synthetic-batch", sourceRowNumber: 3,
        occurredAt: "2026-08-20", amount: "-80.00", direction: "DEBIT", counterparty: "合成退款方",
        counterpartyDigest: null, description: "退款", descriptionDigest: null, externalReference: null, invoiceReference: null
      },
      suggestions: [{ paymentId: "synthetic-payment-1", score: 80, confidence: "MEDIUM", reason: "金额等于未关联退款", autoConfirm: false, candidateSummary: "案件 SYN-001 · 可关联退款 ¥80.00" }]
    }]}} />);

    expect(screen.getByRole("button", { name: "关联退款" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "接受建议" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /SYN-001/ })).toBeInTheDocument();
  });

  it("月结工作台要求先预览，正式提交在初始状态不可点", () => {
    render(<MonthlyCloseWorkspace data={{
      period: "2026-08",
      sourceBatches: [],
      coverageDetails: null,
      status: {
        ready: false, coverageConfirmed: false, sourceFiles: 0, sourceKinds: [], transactionCount: 0, unresolvedCount: 0,
        unresolvedIncomeCount: 0, splitErrorCount: 0, missingPayrollCount: 0, templateWarnings: [],
        blockingWarnings: [], reviewWarnings: [], runId: null, sourceHash: null
      },
      artifacts: [],
      adjustments: []
    } as never} canMaterialize canAdjust={false} canExport={false} />);

    expect(screen.getByRole("button", { name: "预览本期分配" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认正式分配" })).toBeDisabled();
  });
});
