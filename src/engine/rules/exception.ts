import { APPROVED_EXCEPTION_REASONS } from "../incident/types";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";

/**
 * Evaluates whether an order should be ignored due to an approved exception reason
 */
export function isApprovedException(order: NormalizedRillnetOrder): boolean {
  // Check if status itself or order fields contain exception keywords
  const orderString = JSON.stringify(order).toLowerCase();

  for (const reason of APPROVED_EXCEPTION_REASONS) {
    if (orderString.includes(reason.toLowerCase())) {
      return true;
    }
  }

  // Also ignore terminal statuses if present
  const terminalStatuses = [
    "delivered",
    "canceled",
    "cancelled",
    "returned",
    "return",
    "lost",
  ];
  if (terminalStatuses.includes(order.status.toLowerCase().trim())) {
    return true;
  }

  return false;
}
