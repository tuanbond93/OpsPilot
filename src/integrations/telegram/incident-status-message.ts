export type IncidentStatusLine = { warehouse: string; reason: string; previousCount: number | null; currentCount: number; resolved: boolean };
const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatIncidentStatusUpdate(lines: IncidentStatusLine[], completedAt: string) {
  return [
    "<b>CẬP NHẬT TRẠNG THÁI SAU SYNC</b>",
    `Hoàn tất: ${new Date(completedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    "",
    ...lines.map((line) => line.resolved
      ? `✅ <b>Sự cố đã hoàn thành</b> · ${esc(line.warehouse)} · ${esc(line.reason)} · ${line.previousCount ?? "—"} → 0 đơn`
      : `${line.previousCount === line.currentCount ? "➖ Không thay đổi" : "🔄 Có thay đổi"} · ${esc(line.warehouse)} · ${esc(line.reason)} · ${line.previousCount ?? "—"} → ${line.currentCount} đơn`),
    "",
    "Sự cố chưa hoàn thành sẽ tiếp tục được cập nhật ở chu kỳ sync sau.",
  ].join("\n");
}

export function formatSyncHeartbeat(input: { completedAt: string; active: number; changed: number; unchanged: number; resolved: number; failed: number }) {
  return [
    "<b>SYNC OPSPILOT ĐÃ HOÀN TẤT</b>",
    `Thời gian: ${new Date(input.completedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    `Đang theo dõi: <b>${input.active}</b> case`,
    `Có thay đổi: <b>${input.changed}</b> · Không thay đổi: <b>${input.unchanged}</b>`,
    `Sự cố đã hoàn thành: <b>${input.resolved}</b>`,
    `Lỗi gửi trạng thái: <b>${input.failed}</b>`,
  ].join("\n");
}
