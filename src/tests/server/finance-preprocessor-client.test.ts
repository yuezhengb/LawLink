import { afterEach, describe, expect, it, vi } from "vitest";
import { preprocessFinanceUpload } from "@/server/finance/finance-preprocessor-client";

const originalUrl = process.env.FINANCE_PREPROCESSOR_URL;
const originalToken = process.env.FINANCE_PREPROCESSOR_TOKEN;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.FINANCE_PREPROCESSOR_URL;
  else process.env.FINANCE_PREPROCESSOR_URL = originalUrl;
  if (originalToken === undefined) delete process.env.FINANCE_PREPROCESSOR_TOKEN;
  else process.env.FINANCE_PREPROCESSOR_TOKEN = originalToken;
});

describe("财务文件预处理客户端", () => {
  it("旧 XLS 转成 XLSX bytes，并使用安全生成的输出名", async () => {
    process.env.FINANCE_PREPROCESSOR_URL = "http://finance-preprocessor:8080";
    process.env.FINANCE_PREPROCESSOR_TOKEN = "synthetic-secret";
    const converted = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const fetcher = vi.fn().mockResolvedValue(new Response(converted, {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    }));

    const result = await preprocessFinanceUpload({ fileName: "payroll.xls", kind: "PAYROLL", bytes: Buffer.from("legacy") }, { fetcher });

    expect(result).toEqual({ kind: "XLSX", fileName: "payroll.xlsx", bytes: converted });
    expect(fetcher.mock.calls[0][0]).toBe("http://finance-preprocessor:8080/v1/preprocess");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-secret", "X-Source-Kind": "PAYROLL" });
  });

  it("PDF 表格结果校验页码和来源坐标", async () => {
    process.env.FINANCE_PREPROCESSOR_URL = "http://finance-preprocessor:8080";
    process.env.FINANCE_PREPROCESSOR_TOKEN = "synthetic-secret";
    const document = { version: 1, pages: [{ pageNumber: 2, extraction: "TEXT_TABLE", tables: [[["日期", "金额"], ["2026-08-01", "100"]]], ocrWords: [] }] };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(document), { headers: { "Content-Type": "application/json" } }));

    await expect(preprocessFinanceUpload({ fileName: "bank.pdf", kind: "BANK_STATEMENT", bytes: Buffer.from("pdf") }, { fetcher }))
      .resolves.toEqual({ kind: "PDF", document });
  });

  it("未配置 token 时拒绝处理且不发网络请求", async () => {
    process.env.FINANCE_PREPROCESSOR_URL = "http://finance-preprocessor:8080";
    delete process.env.FINANCE_PREPROCESSOR_TOKEN;
    const fetcher = vi.fn();

    await expect(preprocessFinanceUpload({ fileName: "bank.pdf", kind: "BANK_STATEMENT", bytes: Buffer.from("pdf") }, { fetcher }))
      .rejects.toThrow("财务文件预处理服务未配置");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("worker 返回错误时不把响应体、路径或令牌泄漏给调用者", async () => {
    process.env.FINANCE_PREPROCESSOR_URL = "http://finance-preprocessor:8080";
    process.env.FINANCE_PREPROCESSOR_TOKEN = "synthetic-secret";
    const fetcher = vi.fn().mockResolvedValue(new Response("private path and extracted values", { status: 422 }));

    await expect(preprocessFinanceUpload({ fileName: "bank.pdf", kind: "BANK_STATEMENT", bytes: Buffer.from("pdf") }, { fetcher }))
      .rejects.toThrow("来源文件无法安全预处理");
  });
});
