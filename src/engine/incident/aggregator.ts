import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import type { Incident, IncidentReason, RuleConfig } from "./types";
import { DEFAULT_RULE_CONFIG, REASON_CODE_MAP, generateIncidentKey } from "./types";
import { inspectOrderForIncident } from "./builder";
import { calculateIncidentPriorityScore } from "../rules/priority";

/**
 * Aggregates normalized orders into consolidated operational incidents with metrics
 */
export function aggregateIncidents(
  orders: NormalizedRillnetOrder[],
  config: RuleConfig = DEFAULT_RULE_CONFIG,
  referenceTimeMs: number = Date.now(),
  activeExceptions: Set<string> = new Set()
): Incident[] {
  const incidentGroupMap = new Map<
    string,
    {
      warehouseId: string;
      warehouseName: string;
      reason: IncidentReason;
      orders: NormalizedRillnetOrder[];
      ages: number[];
    }
  >();

  for (const order of orders) {
    const orderCode = (order.orderCode || order.id).trim();

    // Exclude order if active database exception exists
    if (activeExceptions.has(orderCode)) {
      continue;
    }

    const match = inspectOrderForIncident(order, config, referenceTimeMs);
    if (!match) continue;

    const warehouseId = order.warehouseId || "unknown-wh";
    const warehouseName = order.warehouseName || "Kho chưa xác định";
    const reasonMeta = REASON_CODE_MAP[match.reason];
    const key = generateIncidentKey(warehouseId, reasonMeta.code);

    const existing = incidentGroupMap.get(key);
    if (existing) {
      existing.orders.push(order);
      existing.ages.push(match.ageHours);
    } else {
      incidentGroupMap.set(key, {
        warehouseId,
        warehouseName,
        reason: match.reason,
        orders: [order],
        ages: [match.ageHours],
      });
    }
  }

  const incidents: Incident[] = [];

  for (const [, group] of incidentGroupMap.entries()) {
    const reasonMeta = REASON_CODE_MAP[group.reason];
    const incidentKey = generateIncidentKey(group.warehouseId, reasonMeta.code);
    
    // All affected order codes for backend persistence
    const affectedOrders = group.orders.map((o) => o.orderCode || o.id);
    // Sample max 5 order codes for UI preview
    let sampleOrderCodes = group.orders.slice(0, 5).map((o) => o.orderCode || o.id);
    const affectedOrderCount = group.orders.length;

    // Calculate age metrics
    const ages = group.ages;
    const totalAge = ages.reduce((sum, a) => sum + a, 0);
    const averageAgeHours = ages.length > 0 ? Math.round((totalAge / ages.length) * 10) / 10 : null;
    const maximumAgeHours = ages.length > 0 ? Math.round(Math.max(...ages) * 10) / 10 : null;

    // Find oldest order code
    let maxAgeIndex = 0;
    for (let i = 1; i < ages.length; i++) {
      if (ages[i] > ages[maxAgeIndex]) {
        maxAgeIndex = i;
      }
    }
    const oldestOrderCode = group.orders[maxAgeIndex]
      ? group.orders[maxAgeIndex].orderCode || group.orders[maxAgeIndex].id
      : null;
    const pickupJourneys = group.orders.flatMap((order) => {
      if (!order.createdAt || !order.endPickAt) return [];
      const created = Date.parse(order.createdAt);
      const picked = Date.parse(order.endPickAt);
      if (!Number.isFinite(created) || !Number.isFinite(picked) || picked < created) return [];
      return [{ orderCode: order.orderCode || order.id, hours: Math.round(((picked - created) / 3_600_000) * 10) / 10 }];
    });
    const delayedPickupJourneys = pickupJourneys.filter((journey) => journey.hours > config.readyToPickMaxHours).sort((a, b) => b.hours - a.hours);
    const pickupJourneyCoveragePercent = affectedOrderCount > 0 ? Math.round((pickupJourneys.length / affectedOrderCount) * 1000) / 10 : 0;
    // The oldest order is operationally more useful than an arbitrary first sample.
    // Keep it first while preserving the existing maximum of five preview codes.
    if (oldestOrderCode) {
      sampleOrderCodes = [oldestOrderCode, ...sampleOrderCodes.filter((code) => code !== oldestOrderCode)].slice(0, 5);
    }

    // Determine oldest (firstDetectedAt) and newest (lastDetectedAt) timestamps
    const timestamps = group.orders
      .map((o) => (o.createdAt ? new Date(o.createdAt).getTime() : null))
      .filter((ts): ts is number => ts !== null && !isNaN(ts))
      .sort((a, b) => a - b);

    const firstDetectedAt =
      timestamps.length > 0
        ? new Date(timestamps[0]).toISOString()
        : new Date(referenceTimeMs).toISOString();

    const lastDetectedAt =
      timestamps.length > 0
        ? new Date(timestamps[timestamps.length - 1]).toISOString()
        : new Date(referenceTimeMs).toISOString();

    const priorityScore = calculateIncidentPriorityScore(
      group.reason,
      affectedOrderCount,
      maximumAgeHours || 0
    );
    const statusCounts = new Map<string, number>();
    for (const order of group.orders) {
      const status = String(order.status || "unknown").trim().toLowerCase() || "unknown";
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    }
    const rillnetStatusSignature = JSON.stringify(
      [...statusCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    );

    incidents.push({
      incidentId: incidentKey, // Stable UUID / Key fallback
      incidentKey,
      warehouseId: group.warehouseId,
      warehouseName: group.warehouseName,
      reasonCode: reasonMeta.code,
      reasonName: reasonMeta.name,
      status: "open",
      priorityScore,
      firstDetectedAt,
      lastDetectedAt,
      affectedOrderCount,
      affectedOrders,
      sampleOrderCodes,
      averageAgeHours,
      maximumAgeHours,
      rillnetStatusSignature,
      oldestOrderCode,
      pickupJourneyCoveragePercent,
      pickupDelayedOrderCount: delayedPickupJourneys.length,
      maximumPickupWaitHours: delayedPickupJourneys[0]?.hours ?? null,
      pickupDelayOrderCodes: delayedPickupJourneys.slice(0, 5).map((journey) => journey.orderCode),
    });
  }

  // Sort by priorityScore descending
  incidents.sort((a, b) => b.priorityScore - a.priorityScore);

  return incidents;
}
