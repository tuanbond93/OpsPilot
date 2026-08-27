import { describe, expect, it } from "vitest";
import { buildWorkOrderCallbackData, parseWorkOrderCallbackData, workOrderInlineKeyboard } from "@/integrations/telegram/work-order-actions";

describe("Telegram work-order callbacks", () => {
  const dispatchId = "f2f62f64-2748-4fcb-a51d-26df6be6a22f";

  it("round-trips a signed-format acknowledgement action", () => {
    expect(parseWorkOrderCallbackData(buildWorkOrderCallbackData(dispatchId, "ACKNOWLEDGED"))).toEqual({ dispatchId, signal: "ACKNOWLEDGED" });
  });

  it("rejects callback data outside the work-order format", () => {
    expect(parseWorkOrderCallbackData("execute:COMPLETED")).toBeNull();
  });

  it("provides the three non-transitioning pilot actions", () => {
    expect(workOrderInlineKeyboard(dispatchId).flat().map((button) => button.text)).toEqual(["Nhận việc", "Cần hỗ trợ", "Đã cập nhật tiến độ"]);
  });
});
