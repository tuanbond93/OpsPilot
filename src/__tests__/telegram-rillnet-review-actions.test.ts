import { describe, expect, it } from "vitest";
import { buildRillnetReviewCallbackData, parseRillnetReviewCallbackData, rillnetReviewKeyboard } from "@/integrations/telegram/rillnet-review-actions";

const requestId = "8a8e3a42-8dc2-4ab0-a50b-4d36e80c9fc3";

describe("Telegram Rillnet manager review actions", () => {
  it("round-trips every supported outcome within Telegram's callback limit", () => {
    for (const outcome of ["SUCCESS", "FAILED", "CONTINUE"] as const) {
      const value = buildRillnetReviewCallbackData(requestId, outcome);
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
      expect(parseRillnetReviewCallbackData(value)).toEqual({ requestId, outcome });
    }
  });

  it("rejects malformed and unsupported callback data", () => {
    expect(parseRillnetReviewCallbackData(`opsrr:${requestId}:APPROVE`)).toBeNull();
    expect(parseRillnetReviewCallbackData("opsrr:not-a-uuid:SUCCESS")).toBeNull();
    expect(parseRillnetReviewCallbackData(null)).toBeNull();
  });

  it("offers all three explicit manager outcomes", () => {
    const buttons = rillnetReviewKeyboard(requestId).flat();
    expect(buttons.map((button) => button.text)).toEqual(["✅ Thành công", "❌ Thất bại", "👀 Theo dõi tiếp"]);
  });

  it("adds copy buttons for unique sample order codes before review actions", () => {
    const rows = rillnetReviewKeyboard(requestId, ["A123", "A123", "B456"]);
    expect(rows.slice(0, 2)).toEqual([
      [{ text: "📋 A123", copyText: "A123" }],
      [{ text: "📋 B456", copyText: "B456" }],
    ]);
    expect(rows.flat().slice(-3).map((button) => button.text)).toEqual(["✅ Thành công", "❌ Thất bại", "👀 Theo dõi tiếp"]);
  });
});
