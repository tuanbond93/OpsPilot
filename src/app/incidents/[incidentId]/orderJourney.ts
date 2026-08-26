import { orderStatusLabel, repairOperationalText } from "@/app/_components/operationalText";

export type IncidentOrderJourneySource = {
  order_code: string; warehouse_id?: string | null; warehouse_name?: string | null; source_status?: string | null;
  order_created_at?: string | null; source_updated_at?: string | null; age_hours?: number | null;
  pick_warehouse_id?: string | null; deliver_warehouse_id?: string | null;
  end_pick_at?: string | null; end_delivery_at?: string | null; end_success_at?: string | null;
  customer_id?: string | null; customer_name?: string | null; customer_code?: string | null;
  warehouse_log?: unknown;
};
export type JourneyPoint = { label: string; at?: string; detail?: string; done: boolean; current?: boolean; durationFromPreviousHours?: number; slowest?: boolean };

export function validJourneyTime(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

export function journeyFor(order: IncidentOrderJourneySource, warehouseNames: Record<string, string>, snapshotHistory: Array<Record<string, unknown>>): JourneyPoint[] {
  const points: JourneyPoint[] = [];
  const warehouseName = (id: string, fallback?: unknown) => repairOperationalText(warehouseNames[id] || fallback || (id ? `Kho ${id}` : "Chưa xác định"));
  const add = (label: string, at: unknown, detail: string | undefined, done: boolean) => points.push({ label, at: validJourneyTime(at) ? at : undefined, detail, done });
  add("Lên đơn", order.order_created_at, undefined, validJourneyTime(order.order_created_at));
  const logs = Array.isArray(order.warehouse_log) ? order.warehouse_log : [];
  // warehouse_id in an incident snapshot can describe the routing target, not
  // a warehouse the parcel has already visited. Once source logs exist, they
  // are the authoritative visit evidence; history is only a legacy fallback.
  const visits: Array<{ id: string; name?: unknown; at?: unknown }> = logs.length === 0
    ? snapshotHistory.map((snapshot) => ({ id: String(snapshot.warehouse_id || ""), name: snapshot.warehouse_name, at: snapshot.source_updated_at }))
    : [];
  for (const raw of logs) {
    if (!raw || typeof raw !== "object") continue;
    const log = raw as Record<string, unknown>;
    const warehouseId = String(log.current_warehouse_id ?? log.warehouse_id ?? log.warehouseId ?? "");
    const nestedUpdatedDate = log.updated_date && typeof log.updated_date === "object" ? (log.updated_date as Record<string, unknown>).$date : undefined;
    const at = nestedUpdatedDate ?? log.updated_date ?? log.time ?? log.created_at ?? log.arrived_at ?? log.timestamp;
    visits.push({ id: warehouseId, name: log.warehouse_name ?? log.warehouseName, at });
  }
  visits.sort((a, b) => validJourneyTime(a.at) && validJourneyTime(b.at) ? Date.parse(a.at) - Date.parse(b.at) : 0);
  const pickId = String(order.pick_warehouse_id || "");
  const deliverId = String(order.deliver_warehouse_id || "");
  const currentId = String(order.warehouse_id || "");
  const pickVisit = visits.find((visit) => visit.id && visit.id === pickId);
  add("Kho lấy", order.end_pick_at || pickVisit?.at, warehouseName(pickId, pickVisit?.name), Boolean(order.end_pick_at || pickVisit));
  const seen = new Set<string>([pickId]);
  for (const visit of visits) {
    if (!visit.id || seen.has(visit.id) || visit.id === deliverId) continue;
    seen.add(visit.id);
    add(visit.id === currentId ? "Kho hiện tại" : "Kho trung chuyển", visit.at, warehouseName(visit.id, visit.name), true);
  }
  const normalizedStatus = String(order.source_status || "").toLowerCase();
  const deliverVisit = visits.find((visit) => visit.id && visit.id === deliverId);
  const delivered = Boolean(order.end_success_at || order.end_delivery_at || ["delivered", "success"].includes(normalizedStatus));
  const statusConfirmsDeliveryWarehouse = ["delivering", "storing", "delivered", "success"].includes(normalizedStatus);
  const reachedDeliveryWarehouse = Boolean(deliverVisit || delivered || (deliverId && currentId === deliverId && statusConfirmsDeliveryWarehouse));
  const latestVisitAt = visits.reduce<string | undefined>((latest, visit) => validJourneyTime(visit.at) && (!latest || Date.parse(visit.at) > Date.parse(latest)) ? visit.at : latest, undefined);
  const candidateDeliveryAt = deliverVisit?.at || order.end_delivery_at || order.end_success_at || (reachedDeliveryWarehouse ? order.source_updated_at : undefined);
  const chronologicalDeliveryAt = validJourneyTime(candidateDeliveryAt) && (!latestVisitAt || Date.parse(candidateDeliveryAt) >= Date.parse(latestVisitAt)) ? candidateDeliveryAt : undefined;
  add("Kho giao", chronologicalDeliveryAt, warehouseName(deliverId, reachedDeliveryWarehouse ? order.warehouse_name : undefined), reachedDeliveryWarehouse);
  add("Hoàn tất giao", order.end_success_at || order.end_delivery_at, delivered ? "Đơn đã hoàn tất" : "Chưa hoàn tất", delivered);
  const timedPoints = points.map((point, index) => {
    const previous = points[index - 1];
    if (index === 0 || !validJourneyTime(previous?.at) || !validJourneyTime(point.at)) return point;
    const hours = Math.round(((Date.parse(point.at) - Date.parse(previous.at)) / 3_600_000) * 10) / 10;
    return hours >= 0 ? { ...point, durationFromPreviousHours: hours } : point;
  });
  const longestDuration = Math.max(0, ...timedPoints.map((point) => point.durationFromPreviousHours ?? 0));
  const slowestIndex = longestDuration > 0 ? timedPoints.findIndex((point) => point.durationFromPreviousHours === longestDuration) : -1;
  const lastDoneIndex = timedPoints.reduce((latest, point, index) => point.done ? index : latest, -1);
  return timedPoints.map((point, index) => ({ ...point, current: index === lastDoneIndex && !delivered, slowest: index === slowestIndex }));
}
