import type { ExecutionWorkOrder } from "@/domain/execution-work-order";

type TelegramRecipient = { displayName: string; username?: string | null };
type WorkOrderEvidence = { orderCodes?: string[]; groupTitles?: string[]; affectedOrderCount?: number | null };

export function formatTelegramWorkOrderReminder(workOrder: ExecutionWorkOrder, recipients: TelegramRecipient[], reasons: string[], evidence: WorkOrderEvidence = {}) {
  const recipientNames = recipients.map((recipient) => recipient.username ? `@${recipient.username}` : recipient.displayName).filter(Boolean).join(", ");
  const dueAt = new Date(workOrder.dueAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  return [
    "OPSPILOT · NHẮC VIỆC TỪ MANAGER",
    `Mã công việc: ${workOrder.workOrderCode}`,
    `Kho phụ trách: ${workOrder.owner}`,
    `Người nhận: ${recipientNames || "Nhân sự đã được map"}`,
    `Hạn xử lý: ${dueAt}`,
    `Lý do nhắc: ${reasons.join(" · ")}`,
    evidence.groupTitles?.length ? `Nhóm sự cố: ${evidence.groupTitles.join(" · ")}` : "",
    evidence.orderCodes?.length ? `Mã đơn cần đối soát: ${evidence.orderCodes.slice(0, 8).join(", ")}` : "Mã đơn cần đối soát: xem tin work order gốc hoặc hỏi Manager.",
    "",
    "Vui lòng Reply trực tiếp vào tin work order gốc để xác nhận, báo tiến độ hoặc vướng mắc. Tin nhắn này không tự thay đổi trạng thái công việc.",
  ].join("\n");
}
