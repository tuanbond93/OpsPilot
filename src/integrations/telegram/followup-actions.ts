export type TelegramFollowupSignal = "ACKNOWLEDGED" | "NEEDS_SUPPORT" | "PROGRESS_UPDATED";

const signals: TelegramFollowupSignal[] = ["ACKNOWLEDGED", "NEEDS_SUPPORT", "PROGRESS_UPDATED"];

export function buildFollowupCallbackData(reminderId: string, signal: TelegramFollowupSignal) {
  return `opspf:${reminderId}:${signal}`;
}

export function parseFollowupCallbackData(value: unknown): { reminderId: string; signal: TelegramFollowupSignal } | null {
  if (typeof value !== "string") return null;
  const match = /^opspf:([0-9a-f-]{36}):(ACKNOWLEDGED|NEEDS_SUPPORT|PROGRESS_UPDATED)$/i.exec(value);
  if (!match || !signals.includes(match[2].toUpperCase() as TelegramFollowupSignal)) return null;
  return { reminderId: match[1], signal: match[2].toUpperCase() as TelegramFollowupSignal };
}

export function followupInlineKeyboard(reminderId: string) {
  return [[
    { text: "Đã nhận việc", callbackData: buildFollowupCallbackData(reminderId, "ACKNOWLEDGED") },
    { text: "Cần hỗ trợ", callbackData: buildFollowupCallbackData(reminderId, "NEEDS_SUPPORT") },
  ], [{ text: "Đã cập nhật tiến độ", callbackData: buildFollowupCallbackData(reminderId, "PROGRESS_UPDATED") }]];
}
