import { describe, expect, it } from "vitest";
import { buildFollowupCallbackData, followupInlineKeyboard, parseFollowupCallbackData } from "@/integrations/telegram/followup-actions";

describe("Telegram follow-up aggregate callbacks", () => {
  const reminderId = "f2f62f64-2748-4fcb-a51d-26df6be6a22f";

  it("round-trips an acknowledgement without exposing case identifiers in the UI", () => {
    expect(parseFollowupCallbackData(buildFollowupCallbackData(reminderId, "ACKNOWLEDGED"))).toEqual({ reminderId, signal: "ACKNOWLEDGED" });
    expect(followupInlineKeyboard(reminderId).flat().map((item) => item.text)).toEqual(["Đã nhận việc", "Cần hỗ trợ", "Đã cập nhật tiến độ"]);
  });

  it("rejects callback data outside the aggregate follow-up format", () => {
    expect(parseFollowupCallbackData("opspwo:f2f62f64-2748-4fcb-a51d-26df6be6a22f:ACKNOWLEDGED")).toBeNull();
  });
});
