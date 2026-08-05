import type { Incident } from "../incident/types";

export interface PushEscalationRule {
  shouldEscalate: boolean;
  escalationLevel: number;
}

/**
 * Evaluates whether an incident requires immediate push notification
 */
export function evaluatePushRule(incident: Incident): PushEscalationRule {
  if (incident.priorityScore > 80 || incident.affectedOrderCount >= 50) {
    return { shouldEscalate: true, escalationLevel: 2 };
  }
  if (incident.priorityScore > 40 || incident.affectedOrderCount >= 10) {
    return { shouldEscalate: true, escalationLevel: 1 };
  }
  return { shouldEscalate: false, escalationLevel: 0 };
}
