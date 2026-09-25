import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportWorkspace } from "@/app/(app)/finance/internal/_components/import-workspace";
import { LedgerWorkspace } from "@/app/(app)/finance/internal/_components/ledger-workspace";
import { MonthlyCloseWorkspace } from "@/app/(app)/finance/internal/_components/monthly-close-workspace";
import { ReconciliationWorkspace } from "@/app/(app)/finance/internal/_components/reconciliation-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("内部财务工作区", () => {
  it("没有导入权限时不渲染上传按钮", () => {
    render(<ImportWorkspace batches={[]} reviewRecords={[]} reviewUsers={[]} canImport={false} canReview={false} />);
    expect(screen.queryByRole("button", { name: "上传并预览" })).not.toBeInTheDocument();
  });

  it("导入区支持 PDF，允许修正字段映射，并要求映射变更后重新预览", async () => {
    const preview = (mapping: Record<string, number>, missingFields: string[]) => ({
      fileName: "synthetic.pdf",
      kind: "BANK_STATEMENT",
      headers: ["交易日", "入账数"],
      rows: [{ sourceSheet: "PDF第1页-表1", sourceRowNumber: 2, occurredAt: "2026-08-01", amount: "100.00", direction: "CREDIT", counterparty: "合成***", description: null }],
      errors: [],
      validCount: 1,
      totalRows: 1,
      sheets: [{ sourceSheet: "PDF第1页-表1", headers: ["交易日", "入账数"], headerRowNumber: 1, headersDigest: "a".repeat(64), mapping, missingFields }],
      pdfCandidates: [],
      canCommitStructuredRows: true
    });
    const fetch = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview({ occurredAt: 0 }, ["amount"]))))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview({ occurredAt: 0, amount: 1 }, []))));
    render(<ImportWorkspace batches={[]} reviewRecords={[]} reviewUsers={[]} canImport canReview={false} />);

    const fileInput = screen.getByLabelText("来源文件") as HTMLInputElement;
    expect(fileInput.accept).toContain(".pdf");
    fireEvent.change(fileInput, { target: { files: [new File(["synthetic"], "synthetic.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "上传并预览" }));
    await screen.findByRole("combobox", { name: "PDF第1页-表1 交易金额列" });

    fireEvent.change(screen.getByRole("combobox", { name: "PDF第1页-表1 交易金额列" }), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "提交到归档" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "提交到归档" })).toBeEnabled());
  });

  it("案件登记清单只读比对展示案号差异，不启动导入/提交", async () => {
    const fetch = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        counts: { totalRows: 2, comparableRows: 2, matched: 1, registerOnly: 1, systemOnly: 0, duplicateRegister: 0, contractNumbersUncompared: 2 },
        differences: [{ status: "REGISTER_ONLY", caseNumber: "SYN-CASE-ONLY", contractNumber: "SYN-CONTRACT-ONLY" }],
        warnings: ["系统没有独立合同编号字段；合同编号仅作清单参考，未与案号匹配。"], sheetsReviewed: 1, sheetsSkipped: 0
      })));
    render(<ImportWorkspace batches={[]} reviewRecords={[]} reviewUsers={[]} canImport canReview={false} />);

    const fileInput = screen.getByLabelText("案件登记清单") as HTMLInputElement;
    expect(fileInput.accept).toContain(".xlsx");
    fireEvent.change(fileInput, { target: { files: [new File(["synthetic"], "synthetic.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })] } });
    fireEvent.click(screen.getByRole("button", { name: "只读比对" }));

    expect(await screen.findByText("SYN-CASE-ONLY")).toBeInTheDocument();
    expect(screen.getByText("SYN-CONTRACT-ONLY")).toBeInTheDocument();
    expect(screen.getByText(/不创建、修改案件、合同或收付款/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("/api/finance/internal/imports/case-register-preview");
  });

  it("类型化财务资料在内部财务复核页显示来源姓名并由人工关联", () => {
    render(<ImportWorkspace
      batches={[]}
      reviewRecords={[{
        id: "synthetic-record", batchId: "synthetic-batch", batchFileName: "synthetic-payroll.csv", sourceSheet: "工资明细", sourceRow: 2,
        kind: "PAYROLL", period: "2026-08", asOfDay: null, roleLabel: null, statement: null, item: null, displayName: "合成人员甲",
        amount: null, declaredSalary: "15000.00", actualCashPaid: "12000.00", selfCostDue: "800.00",
        resolvedUserId: null, resolvedUserName: null, reviewStatus: "NEEDS_REVIEW"
      }]}
      reviewUsers={[{ id: "synthetic-user", name: "合成人员", role: "LAWYER" }]}
      canImport={false}
      canReview
    />);

    expect(screen.getByText("工资表 · 工资明细 · 第 2 行 · 2026-08")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "第 2 行关联人员" })).toHaveTextContent("合成人员");
    expect(screen.getByText("来源姓名 合成人员甲")).toBeInTheDocument();
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
