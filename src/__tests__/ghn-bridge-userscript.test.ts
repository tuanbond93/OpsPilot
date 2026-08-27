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
});
