import type { ExecutionWorkOrder } from "@/domain/execution-work-order";

type TelegramRecipient = { displayName: string; username?: string | null };
type WorkOrderEvidence = { orderCodes?: string[]; groupTitles?: string[]; affectedOrderCount?: number | null };

function trimForTelegram(value: string, max = 3400) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function formatTelegramWorkOrderMessage(workOrder: ExecutionWorkOrder, recipients: TelegramRecipient[], evidence: WorkOrderEvidence = {}) {
  const recipientNames = recipients.map((recipient) => recipient.username ? `@${recipient.username}` : recipient.displayName).filter(Boolean).join(", ");
  const dueAt = new Date(workOrder.dueAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const actionItems = workOrder.actionItems.map((item, index) => `${index + 1}. ${item.trim()}`).join("\n");
  const orderCodes = (evidence.orderCodes || []).slice(0, 8);
  return trimForTelegram([
    "OPSPILOT · EXECUTION WORK ORDER",
    `Mã công việc: ${workOrder.workOrderCode}`,
    `Kho phụ trách: ${workOrder.owner}`,
    `Người nhận: ${recipientNames || "Nhân sự đã được map"}`,
    `Hạn xử lý: ${dueAt}`,
    "",
    "Hạng mục cần kiểm tra:",
    actionItems,
    evidence.groupTitles?.length ? `\nNhóm sự cố: ${evidence.groupTitles.join(" · ")}` : "",
    orderCodes.length ? `Mã đơn cần đối soát (${orderCodes.length}${evidence.affectedOrderCount && evidence.affectedOrderCount > orderCodes.length ? `/${evidence.affectedOrderCount} mẫu` : ""}):\n${orderCodes.join(", ")}` : "Mã đơn cần đối soát: Chưa có mã mẫu trong snapshot; hãy báo Manager trước khi kết luận.",
    "",
    "Hãy Reply trực tiếp vào tin nhắn này để báo tiến độ hoặc vướng mắc. OpsPilot chỉ ghi nhận phản hồi; Manager vẫn là người xác nhận trạng thái công việc.",
  ].join("\n"));
}
