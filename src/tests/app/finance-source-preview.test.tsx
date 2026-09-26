import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSourcePreview } from "@/app/(app)/finance/internal/_components/import-source-preview";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("内部财务来源只读预览", () => {
  it("显示原表行列、保留下载入口并禁用缓存", async () => {
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
      batchId: "synthetic-batch",
      fileName: "synthetic-source.xlsx",
      kind: "OTHER",
      available: true,
      sheetCount: 1,
      selectedSheet: {
        index: 0,
        name: "测试表",
        totalRows: 2,
        page: 1,
        totalPages: 1,
        rows: [
          { sourceRow: 1, cells: ["项目", "说明"] },
          { sourceRow: 2, cells: ["合成数据", "仅测试展示"] }
        ]
      },
      ocrCandidatePages: []
    })));

    render(<ImportSourcePreview batchId="synthetic-batch" />);

    expect(await screen.findByText("合成数据")).toBeInTheDocument();
    expect(screen.getByText("仅测试展示")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载原件" })).toHaveAttribute("href", "/api/finance/internal/imports/synthetic-batch/source");
    expect(fetch).toHaveBeenCalledWith(
      "/api/finance/internal/imports/synthetic-batch/preview?sheet=0&page=1",
      { cache: "no-store" }
    );
  });

  it("来源读取失败后提供重试", async () => {
    const fetch = vi.spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        batchId: "synthetic-batch",
        fileName: "synthetic-source.csv",
        kind: "OTHER",
        available: true,
        sheetCount: 1,
        selectedSheet: {
          index: 0,
          name: "CSV",
          totalRows: 1,
          page: 1,
          totalPages: 1,
          rows: [{ sourceRow: 1, cells: ["合成内容"] }]
        },
        ocrCandidatePages: []
      })));

    render(<ImportSourcePreview batchId="synthetic-batch" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("网络暂时不可用");
    await screen.findByRole("button", { name: "重试" });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("合成内容")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
