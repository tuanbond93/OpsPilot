import type { RawRillnetOrder, NormalizedRillnetOrder } from "./types";

/**
 * Proven client ID mapping dictionary from Rillnet source
 */
export const RILLNET_CLIENTS_BY_ID: Record<string, { name: string; code: string }> = {
  "4865319": { name: "Aqua B2C", code: "AQUAB2C" },
  "5167163": { name: "LG LTL", code: "LG" },
  "3755626": { name: "Vua Nệm", code: "VUANEM" },
  "5216348": { name: "Vua Nệm Miền Nam", code: "VUANEMSOUTH" },
  "5195683": { name: "Honor", code: "HONOR" },
  "5035963": { name: "MDLZ", code: "MDLZ" },
  "4639882": { name: "ANTA", code: "ANTA" },
  "5220576": { name: "LocknLock", code: "LOCKNLOCK" },
  "4830442": { name: "KFM", code: "KINGFOODMART" },
  "5098083": { name: "266", code: "266" },
  "4964358": { name: "Aqua B2B", code: "AQUAB2B" },
  "4918970": { name: "Cellphones", code: "CELLPHONES" },
  "5103605": { name: "CellphoneS North (HTV)", code: "CELLPHONESNORTH" },
  "5102167": { name: "LG Electronics South", code: "LGSOUTH" },
  "4740538": { name: "Samsung", code: "SAMSUNG" },
  "4010651": { name: "AUX", code: "AUX" },
  "2862669": { name: "Bulsan", code: "BULSAN" },
  "5238870": { name: "Carry POSM", code: "CARRYPOSM" },
  "4637941": { name: "Cocoon", code: "Cocoon" },
  "4127171": { name: "HPH", code: "HPH" },
  "3188545": { name: "JD-Chint", code: "JDCHINT" },
  "4647044": { name: "KEC", code: "KEC" },
  "5126145": { name: "Ru9", code: "RU9" },
  "4948687": { name: "SF-HALARA", code: "SFHALARA" },
  "4702004": { name: "SF-WP", code: "SFWP" },
  "2829108": { name: "Shein", code: "SHEIN" },
  "3820983": { name: "UPS Miền Bắc", code: "NORTHUPS" },
  "3806724": { name: "UPS Miền Nam", code: "SOUTHUPS" },
  "2934261": { name: "Xiaomi", code: "XIAOMI" },
  "3933872": { name: "Yody", code: "YODY" },
  "219381": { name: "CJL/PALDO", code: "CJ" },
  "2832007": { name: "Con Cưng", code: "CONCUNG" },
  "5044925": { name: "DHL Pepsi", code: "DHLPEPSI" },
  "5127937": { name: "Katinat", code: "KATINAT" },
  "4969542": { name: "Maycha", code: "MAYCHA" },
  "4016133": { name: "Nuti", code: "NUTI" },
  "5119947": { name: "Phê La", code: "PHELA" },
  "4612700": { name: "Wilmar", code: "WILMAR" },
  "127619": { name: "BASPRO", code: "BASPRO" },
  "5247377": { name: "Casper", code: "CASPER" },
  "5264756": { name: "Unicommerce", code: "UNICOMMERCE" },
  "5277000": { name: "Samsung SDS - Xdocs Hải Phòng", code: "SAMSUNGHAIPHONG" },
  "3597908": { name: "Samsung SDS DAN", code: "SAMSUNGDANANG" },
  "5242404": { name: "Honor - Bàn tủ 1m2", code: "HONORBANTU" },
  "5258289": { name: "Honor POSM - Anh Phúc", code: "HONORPOSM" },
  "5282825": { name: "Bluestone", code: "BLUESTONE" },
  "5285197": { name: "FRT B2C", code: "FRTB2C" },
  "4929259": { name: "FRT B2B", code: "FRTB2B" },
  "5254723": { name: "Hướng Nam POSM", code: "HUONGNAMPOSM" },
  "5291287": { name: "Khánh Vân Fashion", code: "KHANHVANFASHION" },
  "4093387": { name: "Trúc Quỳnh", code: "TRUCQUYNH" },
  "5333605": { name: "Lucady", code: "LUCADY" },
  "5325560": { name: "Trạm vớ", code: "TRAMVO" },
  "5337964": { name: "Dầu tràm Cung Đình", code: "DAUTRAM" },
  "5333190": { name: "Hải Nam", code: "HAINAM" },
  "5325608": { name: "Minh Triết", code: "MINHTRIET" },
  "5266220": { name: "Hisense LTL", code: "HISENSELTL" },
  "4691072": { name: "Elmich B2B", code: "ELMICHB2B" },
  "5335186": { name: "Supra", code: "SUPRA" },
  "5155120": { name: "Toshiba B2B", code: "TOSHIBAB2B" },
  "5152151": { name: "Hồng Đạt", code: "HONGDAT" },
  "5386469": { name: "Cocoon", code: "COCOON" },
  "3790610": { name: "Sasin", code: "SASIN" },
  "5359595": { name: "Song Hành", code: "SONGHANH" },
  "656761": { name: "Tipi Global", code: "TIPIGLOBAL" },
  "6455043": { name: "Thịnh Vượng", code: "THINHVUONG" },
  "928165": { name: "Pharma", code: "PHARMA" },
  "5277644": { name: "Vùng đất trẻ thơ", code: "VDTT" },
};

/**
 * Maps raw status string to readable task category
 */
export function mapTaskCategory(status: string): string {
  const normalized = status.toLowerCase().trim();
  if (normalized === "delivering") return "Hối giao";
  if (normalized === "storing") return "Tồn KCT/KTC";
  if (normalized === "transporting") return "Luân chuyển";
  if (normalized === "ready_to_pick") return "Chờ lấy";
  if (normalized === "picking") return "Đang lấy";
  if (normalized === "picked") return "Đã lấy";
  if (["returning", "waiting_to_return", "return_transporting"].includes(normalized)) return "Đơn hoàn";
  return "Đang xử lý";
}

/**
 * Normalizes raw order object from Rillnet snapshot
 */
export function mapRawOrderToNormalized(raw: RawRillnetOrder, fetchedAt: string): NormalizedRillnetOrder {
  const orderCode = String(raw.order_code || raw.code || "").trim();
  const status = String(raw.status || "").toLowerCase().trim();
  const warehouseId = String(raw.current_warehouse_id || "").trim();
  const warehouseName = String(raw.current_warehouse_name || raw.deliver_warehouse_name || "Chưa xác định").trim();
  const customerId = String(raw.client_id || "").trim();
  
  const clientMeta = RILLNET_CLIENTS_BY_ID[customerId];
  const customerName = clientMeta?.name || String(raw.client_order_code || customerId).trim();
  const customerCode = clientMeta?.code || "";

  const createdAt = raw.created_date
    ? String(raw.created_date)
    : raw.order_date
    ? String(raw.order_date)
    : null;
  const timestamp = (value: unknown) => typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
  let warehouseLog: unknown[] = [];
  try {
    const parsed = typeof raw.warehouse_log === "string" ? JSON.parse(raw.warehouse_log) : raw.warehouse_log;
    if (Array.isArray(parsed)) warehouseLog = parsed;
  } catch { /* malformed source log remains unavailable */ }

  return {
    id: `rillnet-${orderCode}-${warehouseId}-${status}`,
    orderCode,
    status,
    taskCategory: mapTaskCategory(status),
    warehouseId,
    warehouseName,
    customerId,
    customerName,
    customerCode,
    createdAt,
    pickWarehouseId: raw.pick_warehouse_id == null ? null : String(raw.pick_warehouse_id),
    deliverWarehouseId: raw.deliver_warehouse_id == null ? null : String(raw.deliver_warehouse_id),
    serviceTypeId: raw.service_type_id == null ? null : String(raw.service_type_id),
    endPickAt: timestamp(raw.end_pick_time),
    endDeliveryAt: timestamp(raw.end_delivery_time),
    endSuccessAt: timestamp(raw.end_success_time),
    warehouseLog,
    fetchedAt,
  };
}
