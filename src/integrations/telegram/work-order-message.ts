import type { ExecutionWorkOrder } from "@/domain/execution-work-order";

type TelegramRecipient = { displayName: string; username?: string | null };

function trimForTelegram(value: string, max = 3400) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function formatTelegramWorkOrderMessage(workOrder: ExecutionWorkOrder, recipients: TelegramRecipient[]) {
  const recipientNames = recipients.map((recipient) => recipient.username ? `@${recipient.username}` : recipient.displayName).filter(Boolean).join(", ");
  const dueAt = new Date(workOrder.dueAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const actionItems = workOrder.actionItems.map((item, index) => `${index + 1}. ${item.trim()}`).join("\n");
  return trimForTelegram([
    "OPSPILOT · EXECUTION WORK ORDER",
    `Mã công việc: ${workOrder.workOrderCode}`,
    `Kho phụ trách: ${workOrder.owner}`,
    `Người nhận: ${recipientNames || "Nhân sự đã được map"}`,
    `Hạn xử lý: ${dueAt}`,
    "",
    "Hạng mục cần kiểm tra:",
    actionItems,
    "",
    "Hãy Reply trực tiếp vào tin nhắn này để báo tiến độ hoặc vướng mắc. OpsPilot chỉ ghi nhận phản hồi; Manager vẫn là người xác nhận trạng thái công việc.",
  ].join("\n"));
}
