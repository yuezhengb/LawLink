import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImportWorkspace } from "@/app/(app)/finance/internal/_components/import-workspace";
import { LedgerWorkspace } from "@/app/(app)/finance/internal/_components/ledger-workspace";

afterEach(() => cleanup());

describe("内部财务工作区", () => {
  it("没有导入权限时不渲染上传按钮", () => {
    render(<ImportWorkspace batches={[]} canImport={false} />);
    expect(screen.queryByRole("button", { name: "上传并预览" })).not.toBeInTheDocument();
  });

  it("没有正式批次时不展示假金额", () => {
    render(<LedgerWorkspace view={{ persons: [], projects: [], firm: null }} />);
    expect(screen.getByText("暂无已提交的财务计算批次")).toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });
});
