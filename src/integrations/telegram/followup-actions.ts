export type TelegramFollowupSignal = "ACKNOWLEDGED" | "NEEDS_SUPPORT" | "PROGRESS_UPDATED";
import { TEAM_LEAD_RESPONSE_LABELS, isTeamLeadActionReason, responseOptions, type TeamLeadResponseCode, type TeamLeadWarehouseClass } from "./team-lead-action";

export type TelegramFollowupStructuredReason = "OUTBOUND_SCHEDULED" | "WAITING_VEHICLE" | "BEFORE_COT" | TeamLeadResponseCode;
export type TelegramFollowupResponse = TelegramFollowupSignal | TelegramFollowupStructuredReason;

const responses: TelegramFollowupResponse[] = [
  "ACKNOWLEDGED",
  "NEEDS_SUPPORT",
  "PROGRESS_UPDATED",
  "OUTBOUND_SCHEDULED",
  "WAITING_VEHICLE",
  "BEFORE_COT",
  "OTHER",
  "DELIVERY_ASSIGNED",
  "DELIVERY_WAITING",
  "DELIVERY_COT_PENDING",
  "COT_PENDING",
  "TRANSIT_MISSED",
  "SENT_UNRECEIVED",
  "IN_TRANSIT",
  "WAREHOUSE_LOST",
];

export const structuredReasonLabels: Record<TelegramFollowupStructuredReason, string> = {
  OUTBOUND_SCHEDULED: "Đã có lịch xuất/chuyển",
  WAITING_VEHICLE: "Đang chờ xe/chuyến",
  BEFORE_COT: "Chưa tới COT xuất",
  ...TEAM_LEAD_RESPONSE_LABELS,
};

export function buildFollowupCallbackData(reminderId: string, response: TelegramFollowupResponse) {
  return `opspf:${reminderId}:${response}`;
}

export function parseFollowupCallbackData(value: unknown): { reminderId: string; signal: TelegramFollowupResponse } | null {
  if (typeof value !== "string") return null;
  const match = /^opspf:([0-9a-f-]{36}):([A-Z_]+)$/i.exec(value);
  const signal = match?.[2].toUpperCase() as TelegramFollowupResponse | undefined;
  if (!match || !signal || !responses.includes(signal)) return null;
  return { reminderId: match[1], signal };
}

export function isStructuredFollowupReason(value: TelegramFollowupResponse): value is TelegramFollowupStructuredReason {
  return value in structuredReasonLabels;
}

export function supportsStructuredOutboundResponses(reasonCode: string | null | undefined) {
  return isTeamLeadActionReason(reasonCode);
}

export function followupInlineKeyboard(reminderId: string, structuredOutbound = false, reasonCode = "", warehouseClass: TeamLeadWarehouseClass = "UNKNOWN") {
  const options = structuredOutbound ? responseOptions(reasonCode, warehouseClass) : null;
  if (options) {
    return options.map((response) => [{ text: structuredReasonLabels[response], callbackData: buildFollowupCallbackData(reminderId, response) }]);
  }
  if (structuredOutbound && !reasonCode) {
    return ["OUTBOUND_SCHEDULED", "WAITING_VEHICLE", "BEFORE_COT", "OTHER"].map((response) => [{
      text: structuredReasonLabels[response as TelegramFollowupStructuredReason],
      callbackData: buildFollowupCallbackData(reminderId, response as TelegramFollowupResponse),
    }]);
  }
  return [[
    { text: "Đã nhận việc", callbackData: buildFollowupCallbackData(reminderId, "ACKNOWLEDGED") },
    { text: "Cần hỗ trợ", callbackData: buildFollowupCallbackData(reminderId, "NEEDS_SUPPORT") },
  ], [{ text: "Đã cập nhật tiến độ", callbackData: buildFollowupCallbackData(reminderId, "PROGRESS_UPDATED") }]];
}

export function followupResponseAcknowledgment(response: TelegramFollowupResponse) {
  if (response === "OTHER") return "Hãy Reply vào tin này và chỉ bổ sung bối cảnh chưa có trong task; không cần nhập lại mã đơn.";
  if (isStructuredFollowupReason(response)) return `Đã ghi nhận: ${structuredReasonLabels[response].toLocaleLowerCase("vi")}. Hệ thống vẫn tiếp tục đối soát và follow-up.`;
  return response === "ACKNOWLEDGED"
    ? "Đã ghi nhận nhận việc. Hãy Reply để giải trình."
    : response === "NEEDS_SUPPORT"
      ? "Đã ghi nhận cần hỗ trợ. Hãy Reply nêu rõ vướng mắc."
      : "Đã ghi nhận cập nhật tiến độ. Hãy Reply nêu nội dung mới.";
}

export function followupResponseLabel(response: TelegramFollowupResponse) {
  return isStructuredFollowupReason(response) ? structuredReasonLabels[response] : followupResponseAcknowledgment(response);
}

type RelatedReminder = { id: string; followup_case_id: string; reminder_stage: string };
type CallbackReminder = { telegram_message_id?: string | number | null; recipient_member_ids?: unknown } | null | undefined;

export function isValidFollowupCallbackTarget(reminder: CallbackReminder, telegramMessageId: string | number | undefined, memberId: string) {
  const recipients = Array.isArray(reminder?.recipient_member_ids)
    ? reminder.recipient_member_ids.filter((value): value is string => typeof value === "string")
    : [];
  return Boolean(reminder && String(reminder.telegram_message_id) === String(telegramMessageId) && recipients.includes(memberId));
}

export function buildFollowupResponseEventRows(
  reminders: RelatedReminder[],
  response: TelegramFollowupResponse,
  context: { actor: string; telegramUpdateId: number; telegramMessageId: number },
) {
  return reminders.map((reminder) => ({
    reminder_id: reminder.id,
    event_type: "SIGNAL_RECEIVED",
    actor: context.actor,
    metadata: {
      signal: response,
      responseKind: isStructuredFollowupReason(response)
        ? response === "OTHER" ? "FREE_TEXT_FALLBACK_REQUESTED" : "STRUCTURED_REASON"
        : "LEGACY_SIGNAL",
      structuredReason: isStructuredFollowupReason(response) ? response : null,
      followupCaseId: reminder.followup_case_id,
      reminderStage: reminder.reminder_stage,
      telegramUpdateId: context.telegramUpdateId,
      telegramMessageId: context.telegramMessageId,
    },
  }));
}
