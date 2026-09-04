export type TelegramFollowupSignal = "ACKNOWLEDGED" | "NEEDS_SUPPORT" | "PROGRESS_UPDATED";
export type TelegramFollowupStructuredReason = "OUTBOUND_SCHEDULED" | "WAITING_VEHICLE" | "BEFORE_COT" | "OTHER";
export type TelegramFollowupResponse = TelegramFollowupSignal | TelegramFollowupStructuredReason;

const responses: TelegramFollowupResponse[] = [
  "ACKNOWLEDGED",
  "NEEDS_SUPPORT",
  "PROGRESS_UPDATED",
  "OUTBOUND_SCHEDULED",
  "WAITING_VEHICLE",
  "BEFORE_COT",
  "OTHER",
];

const structuredReasonLabels: Record<TelegramFollowupStructuredReason, string> = {
  OUTBOUND_SCHEDULED: "Đã có lịch xuất/chuyển",
  WAITING_VEHICLE: "Đang chờ xe/chuyến",
  BEFORE_COT: "Chưa tới COT xuất",
  OTHER: "Khác",
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
  return reasonCode === "KHO_TON" || reasonCode === "KHO_CHU_A_LUAN_CHUYEN";
}

export function followupInlineKeyboard(reminderId: string, structuredOutbound = false) {
  if (structuredOutbound) {
    return [
      [{ text: structuredReasonLabels.OUTBOUND_SCHEDULED, callbackData: buildFollowupCallbackData(reminderId, "OUTBOUND_SCHEDULED") }],
      [{ text: structuredReasonLabels.WAITING_VEHICLE, callbackData: buildFollowupCallbackData(reminderId, "WAITING_VEHICLE") }],
      [{ text: structuredReasonLabels.BEFORE_COT, callbackData: buildFollowupCallbackData(reminderId, "BEFORE_COT") }],
      [{ text: structuredReasonLabels.OTHER, callbackData: buildFollowupCallbackData(reminderId, "OTHER") }],
    ];
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
