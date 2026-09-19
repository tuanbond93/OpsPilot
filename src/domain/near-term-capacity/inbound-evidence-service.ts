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

export interface InboundEvidenceSnapshot {
  status: "AVAILABLE" | "OUTSIDE_OPERATING_WINDOW" | "UNAVAILABLE" | "PARTIAL";
  warehouseId: string;
  warehouseName: string;
  capturedAt: string;
  checkpointAt?: string | null;
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
    totalInboundOrders: number;
    pickedNotTransferred: InboundEvidenceBucket;
    inTransfer: InboundEvidenceBucket;
    arrivalConfirmedExcluded: InboundEvidenceBucket;
    etaKnownOrders: number;
    etaUnknownOrders: number;
    earliestEta: string | null;
    latestEta: string | null;
    allInboundOrderCodes: string[];
  };
  sanitizedSampleOrderIds?: {
    pickedNotTransferred: string[];
    inTransfer: string[];
    arrivalConfirmed: string[];
  };
  riskAssessment: {
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
    currentTime: Date | string | number = new Date()
  ): Promise<InboundEvidenceSnapshot> {
    const capturedAt = new Date(currentTime).toISOString();
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
            }
          }
        } catch {
          // Ignore fallback error if table or order method is absent in test mocks
        }
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
          totalInboundOrders: 0,
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
          etaKnownOrders: 0,
          etaUnknownOrders: 0,
          earliestEta: null,
          latestEta: null,
          allInboundOrderCodes: [],
        },
        riskAssessment: {
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

    // Preliminary Risk Level & Summary
    let preliminaryRiskLevel: "LOW" | "MEDIUM" | "HIGH" | "INVESTIGATION_REQUIRED" = "LOW";
    let summaryVi = "Tồn kho và hàng đến trong giới hạn bình thường.";

    if (!isWithinWindow) {
      preliminaryRiskLevel = "LOW";
      summaryVi = "Ngoài khung giờ giao hàng (07:00–17:00); không kích hoạt can thiệp xử lý trong ngày.";
    } else {
      const totalVolumeOrders = currentBacklogBucket.orderCount + totalInboundOrders;
      if (totalVolumeOrders > 50 || inTransfer.length > 20) {
        preliminaryRiskLevel = "HIGH";
        summaryVi = `Áp lực lớn: ${currentBacklogBucket.orderCount} đơn tồn + ${totalInboundOrders} đơn sắp về. Cần theo dõi sát để kịp giải tỏa.`;
      } else if (totalVolumeOrders > 15 || inTransfer.length > 5) {
        preliminaryRiskLevel = "MEDIUM";
        summaryVi = `Có ${totalInboundOrders} đơn dự kiến về trong khung giờ vận hành. Cần xác nhận phương án giải tỏa.`;
      }
    }

    return {
      status: isWithinWindow ? "AVAILABLE" : "OUTSIDE_OPERATING_WINDOW",
      warehouseId: targetId,
      warehouseName,
      capturedAt,
      checkpointAt,
      sourceFreshness,
      totalOrdersFound: rawCandidates.length,
      operatingWindow: operatingWindowInfo,
      horizon: isWithinWindow ? horizon : null,
      currentBacklog: currentBacklogBucket,
      inbound: {
        totalInboundOrders,
        pickedNotTransferred: pickedNotTransferredBucket,
        inTransfer: inTransferBucket,
        arrivalConfirmedExcluded: arrivalConfirmedBucket,
        etaKnownOrders,
        etaUnknownOrders,
        earliestEta,
        latestEta,
        allInboundOrderCodes,
      },
      sanitizedSampleOrderIds: {
        pickedNotTransferred: pickedNotTransferredBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
        inTransfer: inTransferBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
        arrivalConfirmed: arrivalConfirmedBucket.orderCodes.slice(0, 3).map(sanitizeOrderCode),
      },
      riskAssessment: {
        preliminaryRiskLevel,
        summaryVi,
      },
    };
  }
}
