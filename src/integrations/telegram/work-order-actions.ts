export type TelegramWorkOrderSignal = "ACKNOWLEDGED" | "NEEDS_SUPPORT" | "PROGRESS_UPDATED";

const signals: TelegramWorkOrderSignal[] = ["ACKNOWLEDGED", "NEEDS_SUPPORT", "PROGRESS_UPDATED"];

export function buildWorkOrderCallbackData(dispatchId: string, signal: TelegramWorkOrderSignal) {
  return `opspwo:${dispatchId}:${signal}`;
}

export function parseWorkOrderCallbackData(value: unknown): { dispatchId: string; signal: TelegramWorkOrderSignal } | null {
  if (typeof value !== "string") return null;
  const match = /^opspwo:([0-9a-f-]{36}):(ACKNOWLEDGED|NEEDS_SUPPORT|PROGRESS_UPDATED)$/i.exec(value);
  if (!match || !signals.includes(match[2].toUpperCase() as TelegramWorkOrderSignal)) return null;
  return { dispatchId: match[1], signal: match[2].toUpperCase() as TelegramWorkOrderSignal };
}

export function workOrderInlineKeyboard(dispatchId: string) {
  return [[
    { text: "Nhận việc", callbackData: buildWorkOrderCallbackData(dispatchId, "ACKNOWLEDGED") },
    { text: "Cần hỗ trợ", callbackData: buildWorkOrderCallbackData(dispatchId, "NEEDS_SUPPORT") },
  ], [{ text: "Đã cập nhật tiến độ", callbackData: buildWorkOrderCallbackData(dispatchId, "PROGRESS_UPDATED") }]];
}
