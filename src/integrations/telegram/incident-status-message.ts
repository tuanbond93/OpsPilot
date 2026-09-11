export type IncidentChangeCategory = "NEW" | "INCREASED" | "DECREASED" | "UNCHANGED" | "RESOLVED" | "REOPENED" | "UNKNOWN";
export type IncidentStatusLine = { warehouse: string; reason: string; previousCount: number | null; currentCount: number; resolved: boolean; category?: IncidentChangeCategory };
export type ChangeCounts = Record<IncidentChangeCategory, number>;
const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const emptyChangeCounts = (): ChangeCounts => ({ NEW: 0, INCREASED: 0, DECREASED: 0, UNCHANGED: 0, RESOLVED: 0, REOPENED: 0, UNKNOWN: 0 });
export function classifyIncidentChange(previousCount: number | null, currentCount: number | null, resolved: boolean, reopened = false): IncidentChangeCategory {
  if (reopened) return "REOPENED"; if (resolved || currentCount === 0) return "RESOLVED"; if (currentCount === null) return "UNKNOWN"; if (previousCount === null) return "NEW"; if (currentCount > previousCount) return "INCREASED"; if (currentCount < previousCount) return "DECREASED"; return "UNCHANGED";
}
const categoryOf = (line: IncidentStatusLine) => line.category ?? classifyIncidentChange(line.previousCount, line.currentCount, line.resolved);
const label = (category: IncidentChangeCategory) => ({ NEW: "🆕 Mới phát sinh", INCREASED: "📈 Tồn tăng", DECREASED: "📉 Tồn giảm", UNCHANGED: "➖ Không thay đổi", RESOLVED: "✅ Vừa hoàn thành", REOPENED: "♻️ Mở lại", UNKNOWN: "❔ Chưa đủ dữ liệu" })[category];
export function formatIncidentStatusUpdate(lines: IncidentStatusLine[], completedAt: string, scope = "Miền Bắc 3") {
  const groups = new Map<IncidentChangeCategory, IncidentStatusLine[]>(); for (const line of lines) { const category = categoryOf(line); groups.set(category, [...(groups.get(category) || []), line]); }
  const rows = [...groups.entries()].flatMap(([category, items]) => ["", `<b>${label(category)}</b>`, ...items.map(line => `• ${esc(line.warehouse)} · ${esc(line.reason)} · ${line.previousCount ?? "—"} → ${line.currentCount} đơn`)]);
  return ["<b>OPSPILOT · CẬP NHẬT TRẠNG THÁI</b>", `Phạm vi: <b>${esc(scope)}</b>`, `Hoàn tất: ${new Date(completedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`, ...rows, "", "Các case không có action mới vẫn được theo dõi ở checkpoint sau."].join("\n");
}
export function formatSyncHeartbeat(input: { completedAt: string; active: number; changed: number; unchanged: number; resolved: number; failed: number; categories?: ChangeCounts; scope?: string; actions?: { first: number; second: number; escalation: number; other: number; created: number; success: number; failed: number } }) {
  const categories = input.categories ?? { ...emptyChangeCounts(), INCREASED: input.changed, UNCHANGED: input.unchanged, RESOLVED: input.resolved };
  const actions = input.actions;
  const reported = Object.values(categories).reduce((sum, value) => sum + value, 0);
  const interventionRows = actions ? ["", "<b>CAN THIỆP TẠI CHECKPOINT</b>", `🔔 Nhắc lần 1: <b>${actions.first}</b>`, `🔁 Nhắc lần 2: <b>${actions.second}</b>`, `🚨 Escalate: <b>${actions.escalation}</b>`, `Khác: <b>${actions.other}</b>`, `Không tạo action tại checkpoint này: <b>${Math.max(0, input.active - actions.created)}</b>`, "", "<b>KẾT QUẢ GỬI</b>", `✅ Thành công: <b>${actions.success}</b>`, `❌ Thất bại: <b>${actions.failed + input.failed}</b>`] : ["", "Chi tiết action được báo riêng theo dữ liệu dispatch thực tế."];
  return ["<b>OPSPILOT · CHECKPOINT</b>", `Phạm vi: <b>${esc(input.scope || "Miền Bắc 3")}</b>`, `Thời gian: ${new Date(input.completedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`, `Đang theo dõi: <b>${input.active}</b> case`, "", "<b>BIẾN ĐỘNG TỪ CHECKPOINT TRƯỚC</b>", `🆕 Mới phát sinh: <b>${categories.NEW}</b>`, `📈 Tồn tăng: <b>${categories.INCREASED}</b>`, `📉 Tồn giảm: <b>${categories.DECREASED}</b>`, `➖ Không thay đổi: <b>${categories.UNCHANGED}</b>`, `✅ Vừa hoàn thành từ checkpoint trước: <b>${categories.RESOLVED}</b>`, `♻️ Mở lại: <b>${categories.REOPENED}</b>`, `❔ Chưa đủ dữ liệu: <b>${categories.UNKNOWN}</b>`, `Tổng case đã báo trạng thái: <b>${reported}</b>`, ...interventionRows].join("\n");
}
