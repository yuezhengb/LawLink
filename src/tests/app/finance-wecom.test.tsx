import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinanceWecomWorkspace } from "@/app/(app)/finance/internal/_components/finance-wecom-settings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("财务企微通知界面", () => {
  it("默认不显示 webhook，发送必须先预览并勾选逐次确认", async () => {
    const fetch = vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
        groupLabel: "内部财务群", enabled: false, hasWebhook: false,
        message: "LawLink 财务月结提醒\n期间：2026-08\n状态：待核对\n待处理事项：1 项\n入口：/finance/internal/monthly-close?period=2026-08"
      })));
    render(<FinanceWecomWorkspace initialSettings={{ enabled: false, groupLabel: "", hasWebhook: false }} canManage />);

    expect(screen.queryByRole("button", { name: "发送到目标群" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("企微 Webhook 地址")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("月结期间"), { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    expect(await screen.findByText(/LawLink 财务月结提醒/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送到目标群" })).toBeDisabled();
    expect(screen.getByLabelText("我已核对以上内容，并确认发送到所示群聊")).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("期间变化后清除旧预览与发送确认，设置表单输入不被服务端回显", async () => {
    const fetch = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
      groupLabel: "内部财务群", enabled: true, hasWebhook: true,
      message: "LawLink 财务月结提醒\n期间：2026-08\n状态：待核对\n待处理事项：0 项\n入口：/finance/internal/monthly-close?period=2026-08"
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, groupLabel: "内部财务群", receipt: "已发送" })));
    render(<FinanceWecomWorkspace initialSettings={{ enabled: true, groupLabel: "内部财务群", hasWebhook: true }} canManage />);
    fireEvent.change(screen.getByLabelText("月结期间"), { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    await screen.findByText(/LawLink 财务月结提醒/);
    fireEvent.click(screen.getByLabelText("我已核对以上内容，并确认发送到所示群聊"));
    fireEvent.click(screen.getByRole("button", { name: "发送到目标群" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe("/api/finance/internal/wecom/send");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ period: "2026-08", confirmed: true });
    fireEvent.change(screen.getByLabelText("月结期间"), { target: { value: "2026-09" } });
    expect(screen.queryByText(/LawLink 财务月结提醒/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送到目标群" })).not.toBeInTheDocument();
  });

  it("无管理权限时隐藏所有配置和发送控件", () => {
    render(<FinanceWecomWorkspace initialSettings={{ enabled: false, groupLabel: "", hasWebhook: false }} canManage={false} />);
    expect(screen.queryByLabelText("企微 Webhook 地址")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送到目标群" })).not.toBeInTheDocument();
  });
});
