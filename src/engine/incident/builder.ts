import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import type { IncidentReason, RuleConfig } from "./types";
import { DEFAULT_RULE_CONFIG } from "./types";
import { isApprovedException } from "../rules/exception";
import { evaluateOrderSLARule, calculateOrderAgeHours } from "../rules/sla";

export interface EvaluatedOrderMatch {
  order: NormalizedRillnetOrder;
  reason: IncidentReason;
  ageHours: number;
}

/**
 * Inspects a single order against operational rules and exceptions
 */
export function inspectOrderForIncident(
  order: NormalizedRillnetOrder,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
  referenceTimeMs: number = Date.now()
): EvaluatedOrderMatch | null {
  // Ignore orders with approved exception reasons or terminal statuses
  if (isApprovedException(order)) {
    return null;
  }

  const reason = evaluateOrderSLARule(order, config, referenceTimeMs);
  if (!reason) {
    return null;
  }

  const ageHours = calculateOrderAgeHours(order, referenceTimeMs);

  return {
    order,
    reason,
    ageHours,
  };
}
