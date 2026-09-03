import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("GHN Tampermonkey recipient capture", () => {
  it("stores recipient details under the labelled order code instead of another input value", async () => {
    const script = readFileSync("public/ghn-bridge.user.js", "utf8");
    const stored = new Map<string, unknown>();
    const setValue = vi.fn(async (key: string, value: unknown) => { stored.set(key, value); });
    const pageText = [
      "Mã đơn hàng", "GY8HMQAW", "Thông tin người nhận", "Họ và tên:", "Người nhận thử nghiệm",
      "Số điện thoại:", "0900000000", "Địa chỉ:", "Số 1, Phường Mẫu, Tỉnh Mẫu",
      "Quận/Huyện:", "Quận Mẫu", "Phường/Xã:", "Phường Mẫu"
    ].join("\n");
    const pageWindow = {
      Headers,
      setInterval: (callback: () => void) => { void callback(); return 1; },
      clearInterval: vi.fn()
    };

    runInNewContext(script, {
      location: { hostname: "nhanh.ghn.vn", href: "https://nhanh.ghn.vn/order/detail" },
      document: {
        body: { innerText: pageText },
        documentElement: {},
        querySelectorAll: () => [{ value: "0900000000" }, { value: "WRONG123" }]
      },
      window: pageWindow,
      unsafeWindow: pageWindow,
      MutationObserver: class { observe() {} },
      GM_getValue: async (key: string) => stored.get(key) ?? null,
      GM_setValue: setValue,
      URL,
      console
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setValue).toHaveBeenCalledWith("opspilot_ghn_order_detail:GY8HMQAW", expect.objectContaining({
      recipientName: "Người nhận thử nghiệm",
      recipientAddress: "Số 1, Phường Mẫu, Tỉnh Mẫu",
      source: "ghn_order_detail_dom"
    }));
    expect([...stored.keys()]).not.toContain("opspilot_ghn_order_detail:WRONG123");
  });

  it("captures tracking and last-mile tokens separately from their respective GHN APIs", async () => {
    const script = readFileSync("public/ghn-bridge.user.js", "utf8");
    const stored = new Map<string, unknown>();
    const setValue = vi.fn(async (key: string, value: unknown) => { stored.set(key, value); });
    class FakeXMLHttpRequest {
      __opspilotRequestUrl = "";
      __opspilotOrderCode: string | null = null;
      responseText = "{}";
      open(_method: string, _url: string) {}
      setRequestHeader(_header: string, _value: string) {}
      send() {}
      addEventListener() {}
    }
    const pageWindow = {
      Headers,
      XMLHttpRequest: FakeXMLHttpRequest,
      setInterval: (callback: () => void) => { void callback(); return 1; },
      clearInterval: vi.fn()
    };

    runInNewContext(script, {
      location: { hostname: "tracuunoibo.ghn.vn", href: "https://tracuunoibo.ghn.vn/internal" },
      document: { body: { innerText: "" }, documentElement: {}, querySelectorAll: () => [] },
      window: pageWindow,
      unsafeWindow: pageWindow,
      MutationObserver: class { observe() {} },
      GM_getValue: async (key: string) => stored.get(key) ?? null,
      GM_setValue: setValue,
      URL,
      console
    });

    const trackingRequest = new pageWindow.XMLHttpRequest();
    trackingRequest.open("GET", "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/order-logs");
    trackingRequest.setRequestHeader("token", "tracking-token-1234567890");
    const lastmileRequest = new pageWindow.XMLHttpRequest();
    lastmileRequest.open("POST", "https://nhanh-api.ghn.vn/api/lastmile/trip/get-trip-list-by-hub");
    lastmileRequest.setRequestHeader("token", "lastmile-token-1234567890");
    lastmileRequest.setRequestHeader("Authorization", "Bearer authorization-1234567890");

    expect(setValue).toHaveBeenCalledWith("opspilot_ghn_tracking_token", "tracking-token-1234567890");
    expect(setValue).toHaveBeenCalledWith("opspilot_ghn_lastmile_token", "lastmile-token-1234567890");
    expect(setValue).toHaveBeenCalledWith("opspilot_ghn_lastmile_authorization", "Bearer authorization-1234567890");
  });

  it("publishes an auto-update URL and the current bridge version", () => {
    const script = readFileSync("public/ghn-bridge.user.js", "utf8");
    expect(script).toContain("// @version      2.3.0");
    expect(script).toContain("// @updateURL    https://opspilot-tau-lyart.vercel.app/ghn-bridge.user.js");
    expect(script).toContain('const BRIDGE_VERSION = "2.3.0";');
  });
});
