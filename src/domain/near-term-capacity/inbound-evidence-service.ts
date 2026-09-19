import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DELIVERY_OPERATING_WINDOW,
  getOperatingWindowClockParts,
  isWithinDeliveryOperatingWindow,
} from "./operating-window";

export type InboundOrderState =
  | "ARRIVAL_CONFIRMED"
  | "IN_TRANSFER"
  | "PICKED_NOT_TRANSFERRED";

export interface NormalizedInboundCandidate {
  orderCode: string;
  currentWarehouseId: string;
  deliverWarehouseId: string;
  sourceStatus?: string | null;
  phase?: string | null;
  weightKg: number | null;
  endPickAt?: string | null;
  eta?: string | null;
  isB2b?: boolean | null;
  warehouseLog?: unknown[];
}

export interface InboundEvidenceBucket {
  orderCount: number;
  knownOrders: number;
  knownWeightKg: number;
  unknownWeightOrders: number;
  orderCodes: string[];
}

export type ObservationType = "NATURAL" | "REPLAY";
export type ReplayEvidenceStatus = "VALID_HISTORICAL" | "INVALID_FUTURE_DATA";
export type PipelinePressure = "LOW" | "MEDIUM" | "HIGH";
export type NearTermArrivalRisk = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface CheckpointTimeInfo {
  checkpoint_at_utc: string;
  checkpoint_at_local: string;
  timezone: "Asia/Ho_Chi_Minh";
}

/**
 * Formats both UTC and Asia/Ho_Chi_Minh (+07:00) ISO strings explicitly.
 */
export function formatCheckpointTimestamps(dateOrIso: Date | string | number): CheckpointTimeInfo {
  const d = new Date(dateOrIso);
  const utcIso = d.toISOString();
  const parts = getOperatingWindowClockParts(d);
  const localIso = `${parts.dateStr}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}+07:00`;
  return {
    checkpoint_at_utc: utcIso,
    checkpoint_at_local: localIso,
    timezone: "Asia/Ho_Chi_Minh",
  };
}

export interface InboundEvidenceSnapshot {
  status: "AVAILABLE" | "OUTSIDE_OPERATING_WINDOW" | "UNAVAILABLE" | "PARTIAL";
  warehouseId: string;
  warehouseName: string;
  capturedAt: string;
  checkpointAt?: string | null;
  checkpoint_at_utc: string;
  checkpoint_at_local: string;
  timezone: "Asia/Ho_Chi_Minh";
  observation_type: ObservationType;
  replay_evidence_status?: ReplayEvidenceStatus;
  sourceFreshness?: string | null;
  totalOrdersFound?: number;
  operatingWindow: {
    timezone: string;
    dailyStart: string;
    dailyEnd: string;
    isWithinWindow: boolean;
  };
  horizon: {
    start: string;
    end: string;
    durationMinutes: number;
  } | null;
  currentBacklog: InboundEvidenceBucket;
  inbound: {
    // Pipeline volume vs horizon arrival separation:
    pipeline_orders: number;
    pipeline_known_kg: number;
    pipeline_unknown_weight_orders: number;
    picked_not_transferred_orders: number;
    in_transfer_orders: number;
    arrival_within_horizon_orders: number | null; // null = UNKNOWN
    arrival_within_horizon_status: "KNOWN" | "UNKNOWN";
    eta_known_orders: number;
    eta_unknown_orders: number;
    earliestEta: string | null;
    latestEta: string | null;

    // Detailed buckets:
    pickedNotTransferred: InboundEvidenceBucket;
    inTransfer: InboundEvidenceBucket;
    arrivalConfirmedExcluded: InboundEvidenceBucket;
    allInboundOrderCodes: string[];
    // Legacy aliases kept for backward compatibility in tests:
    totalInboundOrders: number;
    etaKnownOrders: number;
    etaUnknownOrders: number;
  };
  sanitizedSampleOrderIds?: {
    pickedNotTransferred: string[];
    inTransfer: string[];
    arrivalConfirmed: string[];
  };
  riskAssessment: {
    pipeline_pressure: PipelinePressure;
    near_term_arrival_risk: NearTermArrivalRisk;
    preliminaryRiskLevel: "LOW" | "MEDIUM" | "HIGH" | "INVESTIGATION_REQUIRED";
    summaryVi: string;
  };
  diagnostics?: {
    error?: string;
    missingSources?: string[];
  };
}

/**
 * Sanitizes an order code for operational logs while preserving traceability.
 */
export function sanitizeOrderCode(code: string): string {
  const trimmed = String(code || "").trim();
  if (trimmed.length <= 6) return trimmed;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-3)}`;
}

/**
 * Calculates the governed forecast horizon capped at 17:00 Asia/Ho_Chi_Minh.
 * forecast_end = min(now + 4 hours, today 17:00)
 */
export function computeGovernedForecastHorizon(
  currentTime: Date | string | number = new Date()
): {
  isWithinWindow: boolean;
  horizon: { start: string; end: string; durationMinutes: number } | null;
} {
  const dateObj = new Date(currentTime);
  const isWithin = isWithinDeliveryOperatingWindow(dateObj);
  if (!isWithin) {
    return { isWithinWindow: false, horizon: null };
  }

  const parts = getOperatingWindowClockParts(dateObj);
  const nowMs = dateObj.getTime();
  const fourHoursMs = 4 * 60 * 60 * 1000;
  const fourHoursLaterMs = nowMs + fourHoursMs;

  // Build today 17:00 in Asia/Ho_Chi_Minh (UTC+7)
  // Date string is YYYY-MM-DD
  const closingIso = `${parts.dateStr}T17:00:00+07:00`;
  const closingMs = new Date(closingIso).getTime();

  const endMs = Math.min(fourHoursLaterMs, closingMs);
  const durationMinutes = Math.max(0, Math.round((endMs - nowMs) / (60 * 1000)));

  return {
    isWithinWindow: true,
    horizon: {
      start: dateObj.toISOString(),
      end: new Date(endMs).toISOString(),
      durationMinutes,
    },
  };
}

/**
 * Aggregates a list of orders into weight buckets adhering to UNKNOWN != ZERO semantics.
 */
export function aggregateInboundBucket(
  orders: Array<{ orderCode: string; weightKg: number | null }>
): InboundEvidenceBucket {
  let knownWeightKg = 0;
  let knownOrders = 0;
  let unknownWeightOrders = 0;
  const orderCodes: string[] = [];

  for (const order of orders) {
    orderCodes.push(order.orderCode);
    const w = order.weightKg;
    if (typeof w === "number" && Number.isFinite(w) && w > 0) {
      knownOrders += 1;
      knownWeightKg += w;
    } else {
      unknownWeightOrders += 1;
    }
  }

  return {
    orderCount: orders.length,
    knownOrders,
    knownWeightKg: Math.round(knownWeightKg * 10) / 10,
    unknownWeightOrders,
    orderCodes,
  };
}

/**
 * Deterministically classifies raw order candidates into inbound states.
 * Guarantees mutual exclusion and exact deduplication by orderCode.
 */
export function classifyInboundCandidates(
  targetWarehouseId: string,
  rawOrders: NormalizedInboundCandidate[]
): {
  backlogOrders: NormalizedInboundCandidate[];
  arrivalConfirmed: NormalizedInboundCandidate[];
  inTransfer: NormalizedInboundCandidate[];
  pickedNotTransferred: NormalizedInboundCandidate[];
} {
  const targetId = String(targetWarehouseId).trim();
  const seenCodes = new Set<string>();

  const backlogOrders: NormalizedInboundCandidate[] = [];
  const arrivalConfirmed: NormalizedInboundCandidate[] = [];
  const inTransfer: NormalizedInboundCandidate[] = [];
  const pickedNotTransferred: NormalizedInboundCandidate[] = [];

  for (const item of rawOrders) {
    const code = String(item.orderCode || "").trim();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);

    const currentWh = String(item.currentWarehouseId || "").trim();
    const deliverWh = String(item.deliverWarehouseId || "").trim();
    const sourceStatus = String(item.sourceStatus || "").toLowerCase();
    const phase = String(item.phase || "").toUpperCase();

    // 1. ARRIVAL_CONFIRMED: Already physically at the destination warehouse
    // Excluded from future inbound! Part of current warehouse inventory/backlog.
    if (currentWh === targetId) {
      arrivalConfirmed.push(item);
      backlogOrders.push(item);
      continue;
    }

    // Must be bound for destination warehouse to be considered inbound
    if (deliverWh !== targetId) {
      continue;
    }

    // 2. IN_TRANSFER: Physically in transit between facilities
    const isInTransit =
      sourceStatus === "transporting" ||
      sourceStatus === "in_transit" ||
      phase === "IN_TRANSIT";

    if (isInTransit) {
      inTransfer.push(item);
      continue;
    }

    // 3. PICKED_NOT_TRANSFERRED: Picked/storing at upstream station, not yet departing
    const isPickedOrStoring =
      Boolean(item.endPickAt) ||
      sourceStatus === "picked" ||
      sourceStatus === "storing" ||
      phase === "AT_WAREHOUSE";

    if (isPickedOrStoring) {
      pickedNotTransferred.push(item);
      continue;
    }
  }

  return {
    backlogOrders,
    arrivalConfirmed,
    inTransfer,
    pickedNotTransferred,
  };
}

/**
 * Service to retrieve and compute deterministic inbound evidence.
 */
export class InboundEvidenceService {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Computes authoritative inbound evidence snapshot for a target warehouse.
   */
  async computeInboundEvidence(
    warehouseId: string,
    warehouseName: string,
    currentTime: Date | string | number = new Date(),
    options: { isReplay?: boolean } = {}
  ): Promise<InboundEvidenceSnapshot> {
    const isReplay = options.isReplay ?? false;
    const observation_type: ObservationType = isReplay ? "REPLAY" : "NATURAL";
    const timeInfo = formatCheckpointTimestamps(currentTime);
    const capturedAt = timeInfo.checkpoint_at_utc;
    const targetId = String(warehouseId).trim();

    // 1. Operating Window Check
    const { isWithinWindow, horizon } = computeGovernedForecastHorizon(currentTime);
    const operatingWindowInfo = {
      timezone: DELIVERY_OPERATING_WINDOW.timezone,
      dailyStart: DELIVERY_OPERATING_WINDOW.daily_start,
      dailyEnd: DELIVERY_OPERATING_WINDOW.daily_end,
      isWithinWindow,
    };

    // 2. Query Real Operational Order Data from DB (Fail-soft)
    let rawCandidates: NormalizedInboundCandidate[] = [];
    let sourceFreshness: string | null = null;
    let checkpointAt: string | null = capturedAt;
    let replay_evidence_status: ReplayEvidenceStatus | undefined = undefined;

    try {
      // Find the latest successful sync run
      const { data: latestSync } = await this.db
        .from("sync_runs")
        .select("id, started_at, checkpoint_at, source_updated_at")
        .eq("status", "success")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const syncRunId = latestSync?.id;
      if (latestSync) {
        sourceFreshness = latestSync.source_updated_at || latestSync.checkpoint_at || latestSync.started_at || null;
        checkpointAt = latestSync.checkpoint_at || latestSync.started_at || capturedAt;
      }

      // Replay future-data guard: if sourceFreshness > checkpoint_at_utc, flag INVALID_FUTURE_DATA
      if (isReplay) {
        const checkpointUtcMs = new Date(timeInfo.checkpoint_at_utc).getTime();
        const freshnessMs = sourceFreshness ? new Date(sourceFreshness).getTime() : null;
        if (freshnessMs && freshnessMs > checkpointUtcMs) {
          replay_evidence_status = "INVALID_FUTURE_DATA";
        } else {
          replay_evidence_status = "VALID_HISTORICAL";
        }
      }

      // Query order snapshots for current backlog (warehouse_id = target)
      // AND inbound orders (deliver_warehouse_id = target)
      let orders: any[] = [];
      if (syncRunId) {
        const { data: syncOrders, error: syncError } = await this.db
          .from("order_snapshots")
          .select(
            "order_code, warehouse_id, deliver_warehouse_id, source_status, end_pick_at, weight_kg, is_b2b, warehouse_log, created_at"
          )
          .or(`warehouse_id.eq.${targetId},deliver_warehouse_id.eq.${targetId}`)
          .eq("sync_run_id", syncRunId)
          .limit(1000);

        if (!syncError && syncOrders && syncOrders.length > 0) {
          orders = syncOrders;
        }
      }

      // Fallback: If latest sync run had no orders for this warehouse, read latest snapshots for this warehouse
      if (orders.length === 0) {
        try {
          const { data: recentOrders, error: recentError } = await this.db
            .from("order_snapshots")
            .select(
              "order_code, warehouse_id, deliver_warehouse_id, source_status, end_pick_at, weight_kg, is_b2b, warehouse_log, created_at"
            )
            .or(`warehouse_id.eq.${targetId},deliver_warehouse_id.eq.${targetId}`)
            .order("created_at", { ascending: false })
            .limit(1000);

          if (!recentError && recentOrders && recentOrders.length > 0) {
            orders = recentOrders;
            if (orders[0].created_at) {
              sourceFreshness = orders[0].created_at;
              checkpointAt = orders[0].created_at;
              if (isReplay) {
                const checkpointUtcMs = new Date(timeInfo.checkpoint_at_utc).getTime();
                const freshnessMs = sourceFreshness ? new Date(sourceFreshness).getTime() : null;
                replay_evidence_status = freshnessMs && freshnessMs > checkpointUtcMs ? "INVALID_FUTURE_DATA" : "VALID_HISTORICAL";
              }
            }
          }
        } catch {
          // Ignore fallback error if table or order method is absent in test mocks
        }
      }

      // Replay filter: Exclude any record created after the replay checkpoint
      if (isReplay) {
        const checkpointUtcMs = new Date(timeInfo.checkpoint_at_utc).getTime();
        orders = (orders || []).filter((o: any) => {
          if (!o.created_at) return true;
          return new Date(o.created_at).getTime() <= checkpointUtcMs;
        });
      }

      rawCandidates = (orders || []).map((o: any) => ({
        orderCode: String(o.order_code || ""),
        currentWarehouseId: String(o.warehouse_id || ""),
        deliverWarehouseId: String(o.deliver_warehouse_id || ""),
        sourceStatus: o.source_status,
        weightKg:
          typeof o.weight_kg === "number" && Number.isFinite(o.weight_kg)
            ? o.weight_kg
            : null,
        endPickAt: o.end_pick_at || null,
        eta: null, // explicit operational ETA if present
        isB2b: o.is_b2b,
        warehouseLog: Array.isArray(o.warehouse_log) ? o.warehouse_log : [],
      }));
    } catch (err: any) {
      return {
        status: "UNAVAILABLE",
        warehouseId: targetId,
        warehouseName,
        capturedAt,
        checkpointAt,
        checkpoint_at_utc: timeInfo.checkpoint_at_utc,
        checkpoint_at_local: timeInfo.checkpoint_at_local,
        timezone: timeInfo.timezone,
        observation_type,
        replay_evidence_status,
        sourceFreshness,
        totalOrdersFound: 0,
        operatingWindow: operatingWindowInfo,
        horizon,
        currentBacklog: {
          orderCount: 0,
          knownOrders: 0,
          knownWeightKg: 0,
          unknownWeightOrders: 0,
          orderCodes: [],
        },
        inbound: {
          pipeline_orders: 0,
          pipeline_known_kg: 0,
          pipeline_unknown_weight_orders: 0,
          picked_not_transferred_orders: 0,
          in_transfer_orders: 0,
          arrival_within_horizon_orders: null,
          arrival_within_horizon_status: "UNKNOWN",
          eta_known_orders: 0,
          eta_unknown_orders: 0,
          earliestEta: null,
          latestEta: null,
          pickedNotTransferred: {
            orderCount: 0,
            knownOrders: 0,
            knownWeightKg: 0,
            unknownWeightOrders: 0,
            orderCodes: [],
          },
          inTransfer: {
            orderCount: 0,
            knownOrders: 0,
            knownWeightKg: 0,
            unknownWeightOrders: 0,
            orderCodes: [],
          },
          arrivalConfirmedExcluded: {
            orderCount: 0,
            knownOrders: 0,
            knownWeightKg: 0,
            unknownWeightOrders: 0,
            orderCodes: [],
          },
          allInboundOrderCodes: [],
          totalInboundOrders: 0,
          etaKnownOrders: 0,
          etaUnknownOrders: 0,
        },
        riskAssessment: {
          pipeline_pressure: "LOW",
          near_term_arrival_risk: "UNKNOWN",
          preliminaryRiskLevel: "INVESTIGATION_REQUIRED",
          summaryVi: "Không thể truy vấn dữ liệu hàng đến từ hệ thống; cần điều tra kết nối.",
        },
        diagnostics: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // 3. Classify and Aggregate
    const {
      backlogOrders,
      arrivalConfirmed,
      inTransfer,
      pickedNotTransferred,
    } = classifyInboundCandidates(targetId, rawCandidates);

    const currentBacklogBucket = aggregateInboundBucket(backlogOrders);
    const arrivalConfirmedBucket = aggregateInboundBucket(arrivalConfirmed);
    const inTransferBucket = aggregateInboundBucket(inTransfer);
    const pickedNotTransferredBucket = aggregateInboundBucket(pickedNotTransferred);

    const totalInboundOrders = inTransfer.length + pickedNotTransferred.length;
    const pipeline_orders = totalInboundOrders;
    const pipeline_known_kg = Math.round((pickedNotTransferredBucket.knownWeightKg + inTransferBucket.knownWeightKg) * 10) / 10;
    const pipeline_unknown_weight_orders = pickedNotTransferredBucket.unknownWeightOrders + inTransferBucket.unknownWeightOrders;
    const picked_not_transferred_orders = pickedNotTransferred.length;
    const in_transfer_orders = inTransfer.length;

    const allInboundOrderCodes = [
      ...pickedNotTransferredBucket.orderCodes,
      ...inTransferBucket.orderCodes,
    ];

    // ETA semantics: tracking evidence only
    let etaKnownOrders = 0;
    let etaUnknownOrders = 0;
    const knownEtas: string[] = [];

    for (const item of [...pickedNotTransferred, ...inTransfer]) {
      if (item.eta && Number.isFinite(Date.parse(item.eta))) {
        etaKnownOrders += 1;
        knownEtas.push(item.eta);
      } else {
        etaUnknownOrders += 1;
      }
    }

    knownEtas.sort();
    const earliestEta = knownEtas.length > 0 ? knownEtas[0] : null;
    const latestEta = knownEtas.length > 0 ? knownEtas[knownEtas.length - 1] : null;

    // Arrival within horizon:
    // Without ETA / governed transit-time evidence, arrival within horizon is UNKNOWN
    const arrival_within_horizon_orders = null; // null = UNKNOWN
    const arrival_within_horizon_status: "KNOWN" | "UNKNOWN" = "UNKNOWN";

    // Pipeline pressure: measures the upstream volume heading to this warehouse
    let pipeline_pressure: PipelinePressure = "LOW";
    if (pipeline_orders > 50 || inTransfer.length > 20) {
      pipeline_pressure = "HIGH";
    } else if (pipeline_orders > 15 || inTransfer.length > 5) {
      pipeline_pressure = "MEDIUM";
    }

    // Near-term arrival risk: requires governed arrival timing (ETA).
    // When ETA is NOT_AVAILABLE, arrival within horizon is UNKNOWN.
    let near_term_arrival_risk: NearTermArrivalRisk = "UNKNOWN";
    let preliminaryRiskLevel: "LOW" | "MEDIUM" | "HIGH" | "INVESTIGATION_REQUIRED" = "INVESTIGATION_REQUIRED";

    let summaryVi = "";
    if (!isWithinWindow) {
      pipeline_pressure = "LOW";
      near_term_arrival_risk = "LOW";
      preliminaryRiskLevel = "LOW";
      summaryVi = "Ngoài khung giờ giao hàng (07:00–17:00); không kích hoạt can thiệp xử lý trong ngày.";
    } else {
      if (pipeline_pressure === "HIGH") {
        summaryVi = `Lượng hàng upstream trong pipeline đang lớn (${pipeline_orders} đơn / ${pipeline_known_kg} kg). Chưa đủ bằng chứng xác định bao nhiêu đơn sẽ về trước 17:00.`;
      } else if (pipeline_pressure === "MEDIUM") {
        summaryVi = `Có ${pipeline_orders} đơn trong pipeline về kho. Chưa đủ bằng chứng xác định thời điểm hàng về trước 17:00.`;
      } else {
        summaryVi = "Tồn kho và hàng trong pipeline trong giới hạn bình thường. Chưa có ETA xác định thời điểm về.";
      }
    }

    return {
      status: isWithinWindow ? "AVAILABLE" : "OUTSIDE_OPERATING_WINDOW",
      warehouseId: targetId,
      warehouseName,
      capturedAt,
      checkpointAt,
      checkpoint_at_utc: timeInfo.checkpoint_at_utc,
      checkpoint_at_local: timeInfo.checkpoint_at_local,
      timezone: timeInfo.timezone,
      observation_type,
      replay_evidence_status,
      sourceFreshness,
      totalOrdersFound: rawCandidates.length,
      operatingWindow: operatingWindowInfo,
      horizon: isWithinWindow ? horizon : null,
      currentBacklog: currentBacklogBucket,
      inbound: {
        pipeline_orders,
        pipeline_known_kg,
        pipeline_unknown_weight_orders,
        picked_not_transferred_orders,
        in_transfer_orders,
        arrival_within_horizon_orders,
        arrival_within_horizon_status,
        eta_known_orders: etaKnownOrders,
        eta_unknown_orders: etaUnknownOrders,
        earliestEta,
        latestEta,

        pickedNotTransferred: pickedNotTransferredBucket,
        inTransfer: inTransferBucket,
        arrivalConfirmedExcluded: arrivalConfirmedBucket,
        allInboundOrderCodes,
        totalInboundOrders,
        etaKnownOrders,
        etaUnknownOrders,
      },
      sanitizedSampleOrderIds: {
        pickedNotTransferred: pickedNotTransferredBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
        inTransfer: inTransferBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
        arrivalConfirmed: arrivalConfirmedBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
      },
      riskAssessment: {
        pipeline_pressure,
        near_term_arrival_risk,
        preliminaryRiskLevel,
        summaryVi,
      },
    };
  }
}
