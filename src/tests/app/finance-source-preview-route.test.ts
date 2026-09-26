import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  previewFinanceImportSource: vi.fn(),
  FinanceImportForbiddenError: class extends Error {},
  FinanceImportNotFoundError: class extends Error {}
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/auth/options", () => ({ authOptions: {} }));
vi.mock("@/server/finance/internal-imports", () => ({
  FinanceImportForbiddenError: mocks.FinanceImportForbiddenError,
  FinanceImportNotFoundError: mocks.FinanceImportNotFoundError,
  previewFinanceImportSource: mocks.previewFinanceImportSource
}));

import { GET } from "@/app/api/finance/internal/imports/[id]/preview/route";

afterEach(() => vi.clearAllMocks());

const request = () => new Request("https://finance.example.test/api/finance/internal/imports/synthetic-batch/preview");
const params = { params: Promise.resolve({ id: "synthetic-batch" }) };

describe("财务来源预览 API", () => {
  it("未登录时拒绝请求且明确禁止缓存", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.previewFinanceImportSource).not.toHaveBeenCalled();
  });

  it("登录后的预览也禁止共享缓存并委托权限服务", async () => {
    mocks.getServerSession.mockResolvedValueOnce({ user: { id: "synthetic-finance-user", role: "FINANCE" } });
    mocks.previewFinanceImportSource.mockResolvedValueOnce({
      fileName: "synthetic.xlsx", kind: "OTHER", extension: "xlsx", available: false,
      unavailableReason: "synthetic preview unavailable", sheetCount: 0, selectedSheet: null, ocrCandidatePages: []
    });

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.previewFinanceImportSource).toHaveBeenCalledWith("synthetic-batch", { id: "synthetic-finance-user", role: "FINANCE" }, { sheetIndex: 0, page: 1 });
  });

  it("无来源权限时返回拒绝且仍禁止缓存", async () => {
    mocks.getServerSession.mockResolvedValueOnce({ user: { id: "synthetic-user", role: "USER" } });
    mocks.previewFinanceImportSource.mockRejectedValueOnce(new mocks.FinanceImportForbiddenError("forbidden"));

    const response = await GET(request(), params);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
});
