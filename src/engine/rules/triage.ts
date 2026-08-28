import type { Incident, IncidentReasonCode } from "@/engine/incident";

export const TRIAGE_ROUTING_VERSION = "L10.2C-2026-08-28.1";

export type TriageRoute =
  | "DATA_QUALITY_HOLD"
  | "AUTO_MONITOR"
  | "AUTO_HANDLE"
  | "AI_DECISION_REQUIRED"
  | "HUMAN_INVESTIGATION_REQUIRED";

export type DecisionComplexity = "DETERMINISTIC" | "UNCERTAIN" | "INSUFFICIENT_CONTEXT";
export type TriageSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type TriageInput = Pick<Incident,
  "incidentId" | "incidentKey" | "warehouseId" | "warehouseName" | "reasonCode" | "reasonName" |
  "priorityScore" | "affectedOrderCount" | "sampleOrderCodes" | "firstDetectedAt" | "lastDetectedAt"
> & {
  followupState?: string | null;
  actionRequired?: boolean;
  hasConflictingActions?: boolean;
  zoneName?: string | null;
  pilotZoneNames?: readonly string[];
};

export type TriageResult = {
  route: TriageRoute;
  reasonCode: string;
  severity: TriageSeverity;
  decisionComplexity: DecisionComplexity;
  evidence: Record<string, unknown>;
  /**
   * The deterministic triage is only allowed to change AI queueing inside the
   * configured pilot. Outside it we still record the assessment, but retain
   * the legacy AI-queue policy until a zone is explicitly promoted.
   */
  pilotScope: boolean;
  routingVersion: string;
  triageReason: string;
};

export type RoutePromotion = {
  from: TriageRoute;
  to: TriageRoute;
  reason: "FOLLOWUP_ESCALATED_CONTEXT_INSUFFICIENT" | "PLAYBOOK_ACTIONS_CONFLICT";
};

const KNOWN_ROUTINE_REASONS = new Set<IncidentReasonCode>([
  "KHO_CHU_A_LAY",
  "KHO_TON",
  "KHO_CHU_A_LUAN_CHUYEN",
  "THIEU_SHIPPER",
]);

function isValidTimestamp(value: string | null | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function severityFromPriority(priorityScore: number): TriageSeverity {
  // These are the existing operational urgency bands. They never select the AI route.
  if (priorityScore >= 75) return "CRITICAL";
  if (priorityScore >= 50) return "HIGH";
  if (priorityScore > 0) return "MEDIUM";
  return "LOW";
}

function malformedFields(input: TriageInput): string[] {
  const missing: string[] = [];
  if (!input.incidentId || !input.incidentKey) missing.push("incident_identity");
  if (!input.warehouseId || !input.warehouseName) missing.push("warehouse");
  if (!input.reasonCode || !input.reasonName) missing.push("reason");
  if (!Number.isFinite(input.priorityScore) || input.priorityScore < 0) missing.push("priority_score");
  if (!Number.isInteger(input.affectedOrderCount) || input.affectedOrderCount < 0) missing.push("affected_order_count");
  if (!Array.isArray(input.sampleOrderCodes)) missing.push("sample_order_codes");
  if (!isValidTimestamp(input.firstDetectedAt) || !isValidTimestamp(input.lastDetectedAt)) missing.push("detection_timestamps");
  return missing;
}

export function routeIncident(input: TriageInput): TriageResult {
  const invalid = malformedFields(input);
  const pilotScope = Boolean(input.zoneName && input.pilotZoneNames?.includes(input.zoneName));
  const baseEvidence = {
    incidentKey: input.incidentKey,
    warehouseId: input.warehouseId,
    warehouseName: input.warehouseName,
    affectedOrderCount: input.affectedOrderCount,
    priorityScore: input.priorityScore,
    followupState: input.followupState || "NEW",
    zoneName: input.zoneName || null,
    pilotScope,
  };
  const severity = severityFromPriority(input.priorityScore);

  if (invalid.length > 0) {
    return { route: "DATA_QUALITY_HOLD", reasonCode: input.reasonCode || "UNKNOWN", severity, decisionComplexity: "INSUFFICIENT_CONTEXT", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "MALFORMED_INCIDENT_CONTEXT", evidence: { ...baseEvidence, invalid }, pilotScope };
  }
  if (input.affectedOrderCount === 0) {
    return { route: "DATA_QUALITY_HOLD", reasonCode: input.reasonCode, severity, decisionComplexity: "INSUFFICIENT_CONTEXT", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "ACTIVE_ZERO_REQUIRES_RECONCILIATION", evidence: baseEvidence, pilotScope };
  }
  if (input.actionRequired === false) {
    return { route: "AUTO_MONITOR", reasonCode: input.reasonCode, severity, decisionComplexity: "DETERMINISTIC", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "NO_ACTION_THRESHOLD_REACHED", evidence: baseEvidence, pilotScope };
  }
  if (!KNOWN_ROUTINE_REASONS.has(input.reasonCode as IncidentReasonCode)) {
    return { route: "HUMAN_INVESTIGATION_REQUIRED", reasonCode: input.reasonCode, severity, decisionComplexity: "INSUFFICIENT_CONTEXT", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "UNKNOWN_REASON_NO_AUTO_HANDLE", evidence: baseEvidence, pilotScope };
  }
  if (input.hasConflictingActions) {
    return { route: "AI_DECISION_REQUIRED", reasonCode: input.reasonCode, severity, decisionComplexity: "UNCERTAIN", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "CONFLICTING_PLAYBOOK_ACTIONS", evidence: baseEvidence, pilotScope };
  }
  if (input.followupState === "ESCALATED") {
    return { route: "HUMAN_INVESTIGATION_REQUIRED", reasonCode: input.reasonCode, severity, decisionComplexity: "INSUFFICIENT_CONTEXT", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "DETERMINISTIC_ESCALATION_EXHAUSTED", evidence: baseEvidence, pilotScope };
  }
  return { route: "AUTO_HANDLE", reasonCode: input.reasonCode, severity, decisionComplexity: "DETERMINISTIC", routingVersion: TRIAGE_ROUTING_VERSION, triageReason: "KNOWN_REASON_WITH_ACTIVE_FOLLOWUP", evidence: baseEvidence, pilotScope };
}

/** Only pilot-zone triage is permitted to suppress the legacy AI queue. */
export function shouldEnqueueAiJob(triage: TriageResult): boolean {
  return !triage.pilotScope || triage.route === "AI_DECISION_REQUIRED";
}

/**
 * Promotion is intentionally narrow. The existing Follow-up Engine owns the
 * reminder/escalation lifecycle; this function only makes the hand-off out of
 * AUTO_HANDLE explicit and auditable. It never creates an operational action.
 */
export function getRoutePromotion(previousRoute: TriageRoute | null | undefined, next: TriageResult): RoutePromotion | null {
  if (previousRoute !== "AUTO_HANDLE" || previousRoute === next.route) return null;
  if (next.route === "HUMAN_INVESTIGATION_REQUIRED" && next.triageReason === "DETERMINISTIC_ESCALATION_EXHAUSTED") {
    return {
      from: previousRoute,
      to: next.route,
      reason: "FOLLOWUP_ESCALATED_CONTEXT_INSUFFICIENT",
    };
  }
  if (next.route === "AI_DECISION_REQUIRED" && next.triageReason === "CONFLICTING_PLAYBOOK_ACTIONS") {
    return {
      from: previousRoute,
      to: next.route,
      reason: "PLAYBOOK_ACTIONS_CONFLICT",
    };
  }
  return null;
}
