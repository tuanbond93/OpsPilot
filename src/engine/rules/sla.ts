import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import type { IncidentReason, RuleConfig } from "../incident/types";

/**
 * Calculates order age in hours relative to a reference timestamp (or now)
 */
export function calculateOrderAgeHours(order: NormalizedRillnetOrder, referenceTimeMs: number = Date.now()): number {
  if (!order.createdAt) return 0;
  const createdMs = new Date(order.createdAt).getTime();
  if (isNaN(createdMs)) return 0;

  const diffMs = referenceTimeMs - createdMs;
  return Math.max(0, diffMs / (1000 * 60 * 60));
}

/**
 * Evaluates Rules V1 for a single order
 * Returns IncidentReason if a rule is triggered, or null if compliant
 */
export function evaluateOrderSLARule(
  order: NormalizedRillnetOrder,
  config: RuleConfig,
  referenceTimeMs: number = Date.now()
): IncidentReason | null {
  const status = order.status.toLowerCase().trim();
  const ageHours = calculateOrderAgeHours(order, referenceTimeMs);

  // Rule 1: ready_to_pick older than readyToPickMaxHours (default 24h) -> Kho chưa lấy
  if (status === "ready_to_pick" && ageHours > config.readyToPickMaxHours) {
    return "Kho chưa lấy";
  }

  // Rule 2: storing -> Kho tồn
  if (status === "storing" && ageHours >= config.storingMaxHours) {
    return "Kho tồn";
  }

  // Rule 3: transporting older than transportingMaxHours (default 24h) -> Kho chưa luân chuyển
  if (status === "transporting" && ageHours > config.transportingMaxHours) {
    return "Kho chưa luân chuyển";
  }

  // Rule 4: delivering over deliveringMaxHours (default 12h) -> Thiếu shipper
  if (status === "delivering" && ageHours > config.deliveringMaxHours) {
    return "Thiếu shipper";
  }

  return null;
}
