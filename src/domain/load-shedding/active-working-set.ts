/**
 * Phase 2 — Active Working Set Selector
 *
 * Feature flag: ACTIVE_WORKING_SET_V0=true|false (default: false)
 *
 * Rules:
 * - Include all non-terminal orders regardless of age (unresolved orders remain active even if 20+ days old).
 * - Include terminal orders ONLY IF they had relevant state change during the recent reconciliation window (default: 7 days).
 * - Exclude from heavy processing old terminal orders with no material change.
 * - 7 days is a reconciliation window for recent terminal transitions, NOT an order-age cutoff.
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { ActiveWorkingSetClassification } from "./types";

export const TERMINAL_ORDER_STATUSES = new Set([
  "delivered",
  "canceled",
  "cancelled",
  "returned",
  "return",
  "lost",
  "completed",
  "success",
]);

export const DEFAULT_RECONCILIATION_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days

export function isActiveWorkingSetFeatureEnabled(): boolean {
  return process.env.ACTIVE_WORKING_SET_V0 === "true";
}

export function isTerminalOrderStatus(status?: string | null): boolean {
  if (!status) return false;
  return TERMINAL_ORDER_STATUSES.has(status.trim().toLowerCase());
}

export interface ActiveWorkingSetOptions {
  referenceTimeMs?: number;
  reconciliationWindowMs?: number;
  forceEnabled?: boolean;
}

/**
 * Classifies source orders and produces the active working set.
 * If the feature flag is disabled (and not force-enabled), returns all orders (current legacy behavior).
 */
export function selectActiveWorkingSet(
  orders: NormalizedRillnetOrder[],
  options: ActiveWorkingSetOptions = {}
): ActiveWorkingSetClassification {
  const isEnabled = options.forceEnabled ?? isActiveWorkingSetFeatureEnabled();
  const nowMs = options.referenceTimeMs ?? Date.now();
  const windowMs = options.reconciliationWindowMs ?? DEFAULT_RECONCILIATION_WINDOW_MS;
  const recentThresholdMs = nowMs - windowMs;

  const totalSourceOrders = orders.length;
  let activeOrders = 0;
  let terminalRecent = 0;
  let terminalOld = 0;
  const filteredWorkingSet: NormalizedRillnetOrder[] = [];

  for (const order of orders) {
    const isTerminal = isTerminalOrderStatus(order.status);
    
    // Most recent timestamp representing order change or update
    const updatedMs = order.endDeliveryAt
      ? Date.parse(order.endDeliveryAt)
      : order.endSuccessAt
      ? Date.parse(order.endSuccessAt)
      : order.endPickAt
      ? Date.parse(order.endPickAt)
      : order.fetchedAt
      ? Date.parse(order.fetchedAt)
      : order.createdAt
      ? Date.parse(order.createdAt)
      : 0;

    const isRecentStateChange = Number.isFinite(updatedMs) && updatedMs >= recentThresholdMs;

    if (!isTerminal) {
      // Non-terminal orders are ALWAYS active regardless of age (even 20+ days old)
      activeOrders++;
      filteredWorkingSet.push(order);
    } else {
      if (isRecentStateChange) {
        // Terminal order with recent state change in the 7-day reconciliation window
        terminalRecent++;
        filteredWorkingSet.push(order);
      } else {
        // Old terminal order with no material change -> excluded from heavy processing
        terminalOld++;
      }
    }
  }

  // When feature flag is OFF, legacy behavior preserves 100% of input orders
  const workingSet = isEnabled ? filteredWorkingSet : orders;
  const reductionPercent = totalSourceOrders > 0
    ? Number((((totalSourceOrders - workingSet.length) / totalSourceOrders) * 100).toFixed(2))
    : 0;

  return {
    totalSourceOrders,
    activeOrders,
    terminalRecent,
    terminalOld,
    workingSet,
    reductionPercent: isEnabled ? reductionPercent : 0,
  };
}
