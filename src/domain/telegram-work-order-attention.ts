export type AttentionReason = "UNACKNOWLEDGED" | "NEEDS_SUPPORT" | "DUE_SOON" | "OVERDUE";

export function deriveAttentionReasons(input: { status: string; dueAt: string; signals: string[]; now?: Date }) {
  if (input.status === "COMPLETED") return [] as AttentionReason[];
  const now = input.now || new Date();
  const dueAt = new Date(input.dueAt);
  const result: AttentionReason[] = [];
  if (!input.signals.includes("ACKNOWLEDGED")) result.push("UNACKNOWLEDGED");
  if (input.signals.includes("NEEDS_SUPPORT")) result.push("NEEDS_SUPPORT");
  if (Number.isFinite(dueAt.getTime())) {
    const remainingMs = dueAt.getTime() - now.getTime();
    if (remainingMs < 0) result.push("OVERDUE");
    else if (remainingMs <= 2 * 60 * 60 * 1000) result.push("DUE_SOON");
  }
  return result;
}

export const attentionReasonLabel: Record<AttentionReason, string> = {
  UNACKNOWLEDGED: "Chưa nhận việc",
  NEEDS_SUPPORT: "Cần hỗ trợ",
  DUE_SOON: "Sắp đến hạn",
  OVERDUE: "Quá hạn",
};
