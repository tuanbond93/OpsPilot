import type { ExecutionWorkOrder } from "@/domain/execution-work-order";

type TelegramRecipient = { displayName: string; username?: string | null };

export function formatTelegramWorkOrderReminder(workOrder: ExecutionWorkOrder, recipients: TelegramRecipient[], reasons: string[]) {
  const recipientNames = recipients.map((recipient) => recipient.username ? `@${recipient.username}` : recipient.displayName).filter(Boolean).join(", ");
  const dueAt = new Date(workOrder.dueAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  return [
    "OPSPILOT · NHẮC VIỆC TỪ MANAGER",
    `Mã công việc: ${workOrder.workOrderCode}`,
    `Kho phụ trách: ${workOrder.owner}`,
    `Người nhận: ${recipientNames || "Nhân sự đã được map"}`,
    `Hạn xử lý: ${dueAt}`,
    `Lý do nhắc: ${reasons.join(" · ")}`,
    "",
    "Vui lòng Reply trực tiếp vào tin work order gốc để xác nhận, báo tiến độ hoặc vướng mắc. Tin nhắn này không tự thay đổi trạng thái công việc.",
  ].join("\n");
}
