type TelegramRecipient = { displayName: string; username?: string | null };

export type FirstPushTelegramContext = {
  incidentKey: string;
  warehouseName: string;
  reasonName: string;
  affectedOrderCount: number;
  maximumAgeHours?: number | null;
  orderCodes?: string[];
};

export type FollowupReminderStage = "FIRST" | "SECOND" | "THIRD" | "ESCALATION";

const stageLabel: Record<FollowupReminderStage, string> = {
  FIRST: "NHẮC LẦN 1",
  SECOND: "NHẮC LẦN 2",
  THIRD: "NHẮC LẦN 3",
  ESCALATION: "CẦN MANAGER CAN THIỆP",
};

function escapeTelegramHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function orderLookupLink(orderCode: string) {
  const safeCode = escapeTelegramHtml(orderCode);
  const lookupUrl = `https://tracuunoibo.ghn.vn/internal?order_code=${encodeURIComponent(orderCode)}`;
  return `- <a href="${lookupUrl}">${safeCode}</a>`;
}

export function formatTelegramFollowupReminder(
  stage: FollowupReminderStage,
  context: FirstPushTelegramContext,
  _recipients: TelegramRecipient[]
) {
  const allOrders = [...new Set(context.orderCodes || [])];
  const orders = allOrders.slice(0, 30);
  const needsManager = stage === "ESCALATION";
  return [
    `<b>${stageLabel[stage]}</b>`,
    `Sự cố: ${escapeTelegramHtml(context.reasonName)}`,
    `Kho phụ trách: ${escapeTelegramHtml(context.warehouseName)}`,
    "Mã đơn cần kiểm tra:",
    orders.length ? [orders.map(orderLookupLink).join("\n"), allOrders.length > orders.length ? `- … và ${allOrders.length - orders.length} mã khác trên OpsPilot` : ""].filter(Boolean).join("\n") : "- Chưa có mã đơn trong snapshot; báo Manager trước khi kết luận.",
    "",
    needsManager
      ? "<b>Reply theo từng dòng:</b>\nMÃ_ĐƠN: nguyên nhân / hướng xử lý\nChưa có xử lý sau 3 lần nhắc; Manager xác nhận hướng xử lý tiếp theo."
      : "<b>Reply theo từng dòng:</b>\nMÃ_ĐƠN: nguyên nhân / hướng xử lý",
  ].join("\n");
}

export function formatTelegramFollowupFirstPush(context: FirstPushTelegramContext, recipients: TelegramRecipient[]) {
  return formatTelegramFollowupReminder("FIRST", context, recipients);
}
