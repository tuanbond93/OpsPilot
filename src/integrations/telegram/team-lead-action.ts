import warehouseAssignments from "@/data/warehouse-assignments.generated.json";

export type TeamLeadWarehouseClass = "DELIVERY" | "TRANSIT" | "UNKNOWN";

type GovernedWarehouse = {
  warehouseId: string;
  warehouseName: string;
  warehouseType: string;
  province: string;
};

const governed = warehouseAssignments.warehouses as GovernedWarehouse[];
const byId = new Map(governed.map((item) => [String(item.warehouseId), item]));
const byName = new Map(governed.map((item) => [item.warehouseName, item]));

export function governedWarehouseContext(warehouseId: string | null | undefined, warehouseName: string) {
  const row = byId.get(String(warehouseId || "")) || byName.get(warehouseName);
  const type = row?.warehouseType?.trim() || "";
  const warehouseClass: TeamLeadWarehouseClass = ["Sorting", "KTC", "KCT"].includes(type)
    ? "TRANSIT"
    : ["Bưu cục", "Kho giao", "Kho giao hàng nặng"].includes(type)
      ? "DELIVERY"
      : "UNKNOWN";
  return { province: row?.province?.trim() || "Chưa xác định", warehouseType: type || null, warehouseClass };
}

export function isTeamLeadActionReason(reasonCode: string | null | undefined) {
  return reasonCode === "KHO_TON" || reasonCode === "KHO_CHU_A_LUAN_CHUYEN" || reasonCode === "KHO_CHUA_LUAN_CHUYEN";
}

export type TeamLeadResponseCode =
  | "DELIVERY_ASSIGNED"
  | "DELIVERY_WAITING"
  | "DELIVERY_COT_PENDING"
  | "COT_PENDING"
  | "TRANSIT_MISSED"
  | "SENT_UNRECEIVED"
  | "IN_TRANSIT"
  | "WAREHOUSE_LOST"
  | "OTHER";

export const TEAM_LEAD_RESPONSE_LABELS: Record<TeamLeadResponseCode, string> = {
  DELIVERY_ASSIGNED: "Đã xuất/gán giao",
  DELIVERY_WAITING: "Đang chờ xuất/gán giao",
  DELIVERY_COT_PENDING: "Chưa tới COT luân chuyển",
  COT_PENDING: "Chưa đến COT luân chuyển",
  TRANSIT_MISSED: "Kho luân chuyển sót",
  SENT_UNRECEIVED: "Đã luân chuyển nhưng bưu cục/kho giao chưa nhận hàng",
  IN_TRANSIT: "Đang luân chuyển",
  WAREHOUSE_LOST: "Kho làm mất hàng",
  OTHER: "Khác",
};

export const ALREADY_RESPONDED_USER_MESSAGE = "Phản hồi đã được ghi nhận trước đó và không thể thay đổi.";

export function responseOptions(reasonCode: string, warehouseClass: TeamLeadWarehouseClass): TeamLeadResponseCode[] | null {
  if (reasonCode === "KHO_TON" && warehouseClass === "DELIVERY") return ["DELIVERY_ASSIGNED", "DELIVERY_WAITING", "DELIVERY_COT_PENDING", "OTHER"];
  if (reasonCode === "KHO_TON" && warehouseClass === "TRANSIT") return ["COT_PENDING", "TRANSIT_MISSED", "SENT_UNRECEIVED", "OTHER"];
  if (reasonCode === "KHO_CHU_A_LUAN_CHUYEN" || reasonCode === "KHO_CHUA_LUAN_CHUYEN") return ["IN_TRANSIT", "COT_PENDING", "WAREHOUSE_LOST", "OTHER"];
  return null;
}

function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

export function formatLogicalTarget(orderCodes: string[]) {
  const unique = [...new Set(orderCodes.filter(Boolean))];
  return unique.length ? unique.join(", ") : "Chưa xác định";
}

export function formatTeamLeadActionMessage(input: {
  stage: "FIRST" | "SECOND" | "THIRD" | "ESCALATION";
  province: string;
  warehouseName: string;
  warehouseClass: TeamLeadWarehouseClass;
  reasonCode: string;
  orderCodes: string[];
  previousResponseLabel?: string | null;
}) {
  const target = esc(formatLogicalTarget(input.orderCodes));
  const followup = input.stage !== "FIRST" && input.previousResponseLabel;
  const title = followup ? "🔔 OPSPILOT — CẦN KIỂM TRA LẠI" : input.warehouseClass === "DELIVERY" ? "🔴 OPSPILOT — VIỆC CẦN XỬ LÝ" : "🟠 OPSPILOT — VIỆC CẦN XỬ LÝ";
  const lines = [title, "", `📍 ${esc(input.province)}`, `🏭 ${esc(input.warehouseName)}`, `📦 Đơn: ${target}`, ""];
  if (followup) lines.push("Lần trước đã phản hồi:", esc(input.previousResponseLabel!), "", "Hiện OpsPilot vẫn chưa ghi nhận vấn đề được xử lý.", "");
  if (input.reasonCode === "KHO_TON" && input.warehouseClass === "DELIVERY") {
    lines.push("Vấn đề:", "Đơn đang được ghi nhận tồn tại bưu cục/kho giao.", "", "👉 CẦN KIỂM TRA:", "Tình trạng xử lý hiện tại của đơn là gì?");
  } else if (input.reasonCode === "KHO_TON" && input.warehouseClass === "TRANSIT") {
    lines.push("Vấn đề:", "Đơn đang được ghi nhận tồn tại kho trung chuyển/chuyển tiếp.", "", "👉 CẦN KIỂM TRA:", "Tại sao đơn vẫn còn tại kho?");
  } else {
    lines.push("Vấn đề:", "OpsPilot chưa ghi nhận đơn được luân chuyển sang chặng tiếp theo.", "", "👉 CẦN KIỂM TRA:", "Tại sao chưa luân chuyển?");
  }
  return lines.join("\n");
}

export function formatRecordedResponse(orderCodes: string[], label: string) {
  return ["✅ ĐÃ GHI NHẬN PHẢN HỒI", "", `📦 ${formatLogicalTarget(orderCodes)}`, `Kết quả: ${label}`, "", "OpsPilot sẽ tiếp tục theo dõi ở checkpoint tiếp theo."].join("\n");
}

export function formatOtherPrompt(orderCodes: string[]) {
  return `Vui lòng mô tả ngắn tình trạng thực tế của đơn ${formatLogicalTarget(orderCodes)}.`;
}
