import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type {
  CotResolver,
  CotResult,
  LaneObservationRepository,
  LaneOrderObservationRow,
  LaneTransitionObservationRow,
  PilotLane,
} from "./types";

export * from "./types";

export const PILOT_LANES: readonly PilotLane[] = [
  { fromWarehouseId: "22873000", fromWarehouseName: "Kho B2B - Đức Hòa - Long An", toWarehouseId: "21712000", toWarehouseName: "Kho Giao Hàng Nặng - Tân Bình - HCM" },
  { fromWarehouseId: "22873000", fromWarehouseName: "Kho B2B - Đức Hòa - Long An", toWarehouseId: "21463000", toWarehouseName: "Kho Giao Hàng Nặng - Thủ Đức - HCM" },
  { fromWarehouseId: "23064000", fromWarehouseName: "Kho B2B Supra - Phú Thọ", toWarehouseId: "21160000", toWarehouseName: "Kho Giao Hàng Nặng - Việt Trì" },
  { fromWarehouseId: "1327", fromWarehouseName: "Key Account Warehouse Ho Chi Minh", toWarehouseId: "21712000", toWarehouseName: "Kho Giao Hàng Nặng - Tân Bình - HCM" },
  { fromWarehouseId: "1626", fromWarehouseName: "Kho Trung Chuyển Hồ Chí Minh 01", toWarehouseId: "21094000", toWarehouseName: "Kho Giao Hàng Nặng - Nha Trang" },
] as const;

const TERMINAL_STATUSES = new Set(["delivered", "completed", "success", "returned", "cancelled", "canceled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

export function compareReceiveToCot(receiveObservedAt?: string | null, applicableReceiveCot?: string | null): CotResult {
  if (!receiveObservedAt || !applicableReceiveCot) return "UNKNOWN";
  const receive = Date.parse(receiveObservedAt);
  const cot = Date.parse(applicableReceiveCot);
  if (!Number.isFinite(receive) || !Number.isFinite(cot)) return "UNKNOWN";
  return receive <= cot ? "MET" : "MISSED";
}

/** Resolves a wall-clock receive COT in Asia/Ho_Chi_Minh (+07:00), rolling to N+1 when ordered progression crosses midnight. */
export function resolveReceiveCotDate(baseDate: string, cutOffReceive: string, previousCot?: string): string | null {
  const day = baseDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(cutOffReceive)) return null;
  const seconds = cutOffReceive.length === 5 ? `${cutOffReceive}:00` : cutOffReceive;
  let utc = Date.parse(`${day}T${seconds}+07:00`);
  if (!Number.isFinite(utc)) return null;
  if (previousCot) {
    const previous = Date.parse(previousCot);
    if (Number.isFinite(previous) && utc < previous) utc += 86_400_000;
  }
  return new Date(utc).toISOString();
}

function evidenceTimestamp(log: unknown[], targetWarehouseId: string): string | null {
  const candidates: string[] = [];
  for (const value of log) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const warehouse = String(entry.warehouse_id ?? entry.warehouseId ?? entry.to_warehouse_id ?? entry.toWarehouseId ?? "");
    if (warehouse !== targetWarehouseId) continue;
    for (const key of ["event_at", "eventAt", "created_at", "createdAt", "time", "timestamp"]) {
      const raw = entry[key];
      if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) candidates.push(new Date(raw).toISOString());
    }
  }
  return candidates.sort().at(-1) ?? null;
}

function laneForEntry(order: NormalizedRillnetOrder): PilotLane | undefined {
  return PILOT_LANES.find((lane) => lane.fromWarehouseId === order.warehouseId && lane.toWarehouseId === order.deliverWarehouseId);
}

export class LaneObservationService {
  constructor(
    private readonly repository: LaneObservationRepository,
    private readonly resolveCot: CotResolver = () => ({ status: "UNRESOLVED" })
  ) {}

  async observe(syncRunId: string, observedAt: string, orders: NormalizedRillnetOrder[]): Promise<{ observations: number; transitions: number }> {
    const orderCodes = orders.map((order) => order.orderCode).filter(Boolean);
    const latest = await this.repository.getLatestByOrderCodes(orderCodes);
    const rows: LaneOrderObservationRow[] = [];

    for (const order of orders) {
      const previous = latest.get(order.orderCode);
      const continuedLane = previous && !isTerminalStatus(previous.source_status) && previous.current_warehouse_id !== previous.pilot_lane_to_id
        ? PILOT_LANES.find((lane) => lane.fromWarehouseId === previous.pilot_lane_from_id && lane.toWarehouseId === previous.pilot_lane_to_id)
        : undefined;
      const lane = continuedLane ?? (!isTerminalStatus(order.status) ? laneForEntry(order) : undefined);
      if (!lane) continue;
      const cot = this.resolveCot(order, lane, observedAt);
      rows.push({
        sync_run_id: syncRunId,
        order_code: order.orderCode,
        observed_at: observedAt,
        source_status: order.status,
        current_warehouse_id: order.warehouseId || null,
        current_warehouse_name: order.warehouseName || null,
        deliver_warehouse_id: order.deliverWarehouseId ?? null,
        deliver_warehouse_name: order.deliverWarehouseName ?? null,
        destination_province_id: order.destinationProvinceId ?? null,
        destination_district_id: order.destinationDistrictId ?? null,
        end_pick_at: order.endPickAt ?? null,
        weight_kg: order.weightKg ?? null,
        warehouse_log_evidence: order.warehouseLog ?? [],
        pilot_lane_from_id: lane.fromWarehouseId,
        pilot_lane_to_id: lane.toWarehouseId,
        current_warehouse_first_observed_at: previous?.current_warehouse_id === order.warehouseId
          ? previous.current_warehouse_first_observed_at
          : observedAt,
        resolved_cut_off_receive: cot.cutOffReceive ?? null,
        cot_resolution_status: cot.status,
      });
    }

    const inserted = await this.repository.appendOrderObservations(rows);
    const transitions: LaneTransitionObservationRow[] = [];
    for (const target of inserted) {
      const source = latest.get(target.order_code);
      if (!source?.id || !target.id || !source.current_warehouse_id || !target.current_warehouse_id || source.current_warehouse_id === target.current_warehouse_id) continue;
      const sourceEventAt = evidenceTimestamp(target.warehouse_log_evidence, target.current_warehouse_id);
      const reachedDestination = target.current_warehouse_id === target.pilot_lane_to_id;
      const receiveObservedAt = reachedDestination ? (sourceEventAt ?? target.observed_at) : null;
      const applicableCot = reachedDestination && target.cot_resolution_status === "RESOLVED" ? target.resolved_cut_off_receive : null;
      transitions.push({
        order_code: target.order_code,
        from_warehouse_id: source.current_warehouse_id,
        from_warehouse_name: source.current_warehouse_name,
        to_warehouse_id: target.current_warehouse_id,
        to_warehouse_name: target.current_warehouse_name,
        transition_window_start: source.observed_at,
        transition_window_end: target.observed_at,
        first_observed_at_from: source.current_warehouse_first_observed_at,
        last_observed_at_from: source.observed_at,
        first_observed_at_to: target.observed_at,
        source_event_at: sourceEventAt,
        receive_observed_at: receiveObservedAt,
        applicable_receive_cot: applicableCot,
        cot_result: compareReceiveToCot(receiveObservedAt, applicableCot),
        source_observation_id: source.id,
        target_observation_id: target.id,
      });
    }
    return { observations: inserted.length, transitions: await this.repository.appendTransitions(transitions) };
  }
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function aggregateEmpiricalTransit(rows: LaneTransitionObservationRow[]) {
  const elapsed = rows.map((row) => Date.parse(row.first_observed_at_to) - Date.parse(row.first_observed_at_from)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    label: "EMPIRICAL_OBSERVED_TRANSIT" as const,
    sampleOrders: new Set(rows.map((row) => row.order_code)).size,
    observedTransitions: rows.length,
    elapsedRangeSamples: rows.map((row) => ({
      orderCode: row.order_code,
      observedElapsed: { from: row.first_observed_at_from, to: row.first_observed_at_to },
      transitionWindow: { from: row.transition_window_start, to: row.transition_window_end },
    })),
    medianObservedElapsed: percentile(elapsed, 0.5),
    p25: percentile(elapsed, 0.25),
    p75: percentile(elapsed, 0.75),
    min: elapsed.at(0) ?? null,
    max: elapsed.at(-1) ?? null,
    COT_MET_COUNT: rows.filter((row) => row.cot_result === "MET").length,
    COT_MISSED_COUNT: rows.filter((row) => row.cot_result === "MISSED").length,
    COT_UNKNOWN_COUNT: rows.filter((row) => row.cot_result === "UNKNOWN").length,
  };
}
