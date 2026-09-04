import { describe, expect, it } from "vitest";
import {
  buildFollowupCallbackData,
  buildFollowupResponseEventRows,
  followupInlineKeyboard,
  followupResponseAcknowledgment,
  isValidFollowupCallbackTarget,
  parseFollowupCallbackData,
  supportsStructuredOutboundResponses,
} from "@/integrations/telegram/followup-actions";

describe("Telegram follow-up aggregate callbacks", () => {
  const reminderId = "f2f62f64-2748-4fcb-a51d-26df6be6a22f";

  it("round-trips an acknowledgement without exposing case identifiers in the UI", () => {
    expect(parseFollowupCallbackData(buildFollowupCallbackData(reminderId, "ACKNOWLEDGED"))).toEqual({ reminderId, signal: "ACKNOWLEDGED" });
    expect(followupInlineKeyboard(reminderId).flat().map((item) => item.text)).toEqual(["Đã nhận việc", "Cần hỗ trợ", "Đã cập nhật tiến độ"]);
  });

  it("rejects callback data outside the aggregate follow-up format", () => {
    expect(parseFollowupCallbackData("opspwo:f2f62f64-2748-4fcb-a51d-26df6be6a22f:ACKNOWLEDGED")).toBeNull();
  });

  it("offers distinct outbound reasons only for eligible follow-ups", () => {
    expect(supportsStructuredOutboundResponses("KHO_TON")).toBe(true);
    expect(supportsStructuredOutboundResponses("KHO_CHU_A_LUAN_CHUYEN")).toBe(true);
    expect(supportsStructuredOutboundResponses("KHO_CHU_A_LAY")).toBe(false);
    const buttons = followupInlineKeyboard(reminderId, true).flat();
    expect(buttons.map((item) => item.text)).toEqual([
      "Đã có lịch xuất/chuyển",
      "Đang chờ xe/chuyến",
      "Chưa tới COT xuất",
      "Khác",
    ]);
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callbackData, "utf8")).toBeLessThanOrEqual(64);
      expect(parseFollowupCallbackData(button.callbackData)?.reminderId).toBe(reminderId);
    }
  });

  it("persists a structured reason as evidence with existing task and stage context", () => {
    expect(buildFollowupResponseEventRows([
      { id: reminderId, followup_case_id: "case-1", reminder_stage: "SECOND" },
    ], "WAITING_VEHICLE", { actor: "telegram:member-1", telegramUpdateId: 42, telegramMessageId: 84 })).toEqual([{
      reminder_id: reminderId,
      event_type: "SIGNAL_RECEIVED",
      actor: "telegram:member-1",
      metadata: {
        signal: "WAITING_VEHICLE",
        responseKind: "STRUCTURED_REASON",
        structuredReason: "WAITING_VEHICLE",
        followupCaseId: "case-1",
        reminderStage: "SECOND",
        telegramUpdateId: 42,
        telegramMessageId: 84,
      },
    }]);
  });

  it("records Khác as a measurable fallback and only then requests free text", () => {
    const [event] = buildFollowupResponseEventRows([
      { id: reminderId, followup_case_id: "case-1", reminder_stage: "FIRST" },
    ], "OTHER", { actor: "telegram:member-1", telegramUpdateId: 42, telegramMessageId: 84 });
    expect(event.metadata).toMatchObject({ responseKind: "FREE_TEXT_FALLBACK_REQUESTED", structuredReason: "OTHER" });
    expect(followupResponseAcknowledgment("OTHER")).toContain("Reply");
    expect(followupResponseAcknowledgment("OUTBOUND_SCHEDULED")).not.toContain("Reply");
  });

  it("does not encode a workflow transition in structured evidence", () => {
    const [event] = buildFollowupResponseEventRows([
      { id: reminderId, followup_case_id: "case-1", reminder_stage: "ESCALATION" },
    ], "BEFORE_COT", { actor: "telegram:member-1", telegramUpdateId: 42, telegramMessageId: 84 });
    expect(event).not.toHaveProperty("new_state");
    expect(event).not.toHaveProperty("status");
    expect(event.metadata).not.toHaveProperty("resolved");
  });

  it("maps callbacks only to the exact active message recipient", () => {
    const reminder = { telegram_message_id: 84, recipient_member_ids: ["member-1"] };
    expect(isValidFollowupCallbackTarget(reminder, 84, "member-1")).toBe(true);
    expect(isValidFollowupCallbackTarget(reminder, 85, "member-1")).toBe(false);
    expect(isValidFollowupCallbackTarget(reminder, 84, "member-2")).toBe(false);
    expect(isValidFollowupCallbackTarget(null, 84, "member-1")).toBe(false);
  });

  it("builds the same evidence for a retried Telegram update", () => {
    const input = [{ id: reminderId, followup_case_id: "case-1", reminder_stage: "FIRST" }];
    const context = { actor: "telegram:member-1", telegramUpdateId: 42, telegramMessageId: 84 };
    expect(buildFollowupResponseEventRows(input, "OUTBOUND_SCHEDULED", context))
      .toEqual(buildFollowupResponseEventRows(input, "OUTBOUND_SCHEDULED", context));
  });
});
