import type { GhnOrderLogEntry, LiveOrderTracking } from "./types";
import { canonicalWarehouseName, canonicalWarehouseType } from "./warehouse-directory";

const STATUS_LABELS: Record<string, string> = {
  ready_to_pick: "Chờ lấy hàng",
  picking: "Đang lấy hàng",
  picked: "Đã lấy hàng",
  storing: "Đang lưu tại kho",
  transporting: "Đang trung chuyển",
  delivering: "Đang giao hàng",
  money_collect_delivering: "Đang giao và thu tiền",
  delivery_fail: "Giao hàng không thành công",
  delivered: "Đã giao hàng",
  success: "Đã giao hàng",
  returning: "Đang chuyển hoàn",
  returned: "Đã chuyển hoàn",
};

const text = (value: unknown) => value == null ? null : String(value).trim() || null;
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function phaseFor(status: string | null) {
  if (status === "transporting" || status === "return_transporting") return "IN_TRANSIT" as const;
  if (["delivering", "money_collect_delivering", "delivery_fail"].includes(status || "")) return "DELIVERING" as const;
  if (["delivered", "success", "returned"].includes(status || "")) return "COMPLETED" as const;
  if (status) return "AT_WAREHOUSE" as const;
  return "UNKNOWN" as const;
}

export function parseLiveOrderTracking(
  orderCode: string,
  entries: GhnOrderLogEntry[],
  warehouseNames: Record<string, string> = {},
  checkedAt = new Date().toISOString(),
): LiveOrderTracking {
  const chronological = [...entries].filter((entry) => validTime(entry.created_at)).sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!));
  let status: string | null = null;
  let customerId: string | null = null;
  let currentWarehouseId: string | null = null;
  let nextWarehouseId: string | null = null;
  let pickWarehouseId: string | null = null;
  let deliverWarehouseId: string | null = null;
  let lastAction: string | null = null;
  let lastEventAt: string | null = null;
  let deliveryStartedAt: string | null = null;
  let deliveryStartedAtInferred = false;
  let endDeliveryAt: string | null = null;
  let endSuccessAt: string | null = null;
  const journey: Array<{ warehouseId: string; arrivedAt: string; departedAt?: string; arrivalAction?: string; departureAction?: string }> = [];

  for (const entry of chronological) {
    const patch = entry.new_data || {};
    const at = entry.created_at!;
    const patchAction = text(patch.action);
    const patchWarehouse = text(patch.current_warehouse_id);

    if (patchWarehouse && patchWarehouse !== currentWarehouseId) {
      journey.push({ warehouseId: patchWarehouse, arrivedAt: at, arrivalAction: patchAction || undefined });
      currentWarehouseId = patchWarehouse;
    }
    if (patchAction && ["TRANSFER_TO_TRUCK", "TRANSPORTING"].includes(patchAction) && journey.length) {
      const current = journey[journey.length - 1];
      if (!current.departedAt) {
        current.departedAt = at;
        current.departureAction = patchAction;
      }
    }
    const patchStatus = text(patch.status);
    if (!deliveryStartedAt && ["delivering", "money_collect_delivering"].includes(patchStatus || "")) {
      deliveryStartedAt = at;
      deliveryStartedAtInferred = true;
    }
    if (["delivered", "success"].includes(patchStatus || "")) {
      endDeliveryAt ||= at;
      endSuccessAt ||= at;
    }
    status = patchStatus || status;
    customerId = text(patch.client_id) || customerId;
    nextWarehouseId = text(patch.next_warehouse_id) || nextWarehouseId;
    pickWarehouseId = text(patch.pick_warehouse_id) || pickWarehouseId;
    deliverWarehouseId = text(patch.deliver_warehouse_id) || deliverWarehouseId;
    lastAction = patchAction || lastAction;
    lastEventAt = at;
  }

  const phase = phaseFor(status);
  if (!deliveryStartedAt && phase === "DELIVERING" && lastEventAt) {
    deliveryStartedAt = lastEventAt;
    deliveryStartedAtInferred = true;
  }
  const nameFor = (id: string | null) => canonicalWarehouseName(id, id ? warehouseNames[id] : null);
  return {
    orderCode,
    customerId,
    customerName: null,
    status,
    statusLabel: STATUS_LABELS[status || ""] || status || "Chưa xác định",
    phase,
    currentWarehouseId,
    currentWarehouseName: nameFor(currentWarehouseId),
    nextWarehouseId,
    nextWarehouseName: nameFor(nextWarehouseId),
    pickWarehouseId,
    deliverWarehouseId,
    deliverWarehouseName: nameFor(deliverWarehouseId),
    deliverWarehouseType: canonicalWarehouseType(deliverWarehouseId),
    lastAction,
    lastEventAt,
    checkedAt,
    deliveryStartedAt,
    deliveryStartedAtInferred,
    endDeliveryAt,
    endSuccessAt,
    journey: journey.map((point, index) => ({
      ...point,
      warehouseName: nameFor(point.warehouseId)!,
      current: index === journey.length - 1 && phase !== "IN_TRANSIT" && phase !== "COMPLETED",
    })),
  };
}
