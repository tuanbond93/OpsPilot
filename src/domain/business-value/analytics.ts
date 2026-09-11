import type { FollowupCaseRow, FollowupEventRow, IncidentRow, OrderExceptionRow } from "@/connectors/supabase/types";
import type { NotificationActionEventRow, NotificationActionRow } from "@/engine/action-queue/types";

/**
 * A read model for reporting observed operational outcomes.  It deliberately
 * receives already-read durable rows: this module has no repository, clock,
 * queue, or dispatch dependency and cannot change operational state.
 */
export interface BusinessValueCaseEvidence {
  followupCase: FollowupCaseRow;
  incident?: IncidentRow | null;
  followupEvents?: FollowupEventRow[];
  actions?: NotificationActionRow[];
  actionEvents?: NotificationActionEventRow[];
  /** Case membership is mandatory for action confirmation, including grouped Telegram delivery. */
  caseOrderCodes?: string[];
  /** Complete means every relevant exception source was read for this case at referenceTime. */
  suppressionEvidenceComplete?: boolean;
  orderExceptions?: OrderExceptionRow[];
  /** Additional durable policy observations supplied by a read adapter. */
  suppressionEvidence?: SuppressionEvidence[];
  referenceTime?: string;
  scope?: { province?: string | null; warehouseId?: string | null; warehouseName?: string | null };
}

export type AttributionLevel = "LEVEL_0_TEMPORAL" | "LEVEL_1_GOVERNED_WINDOW" | "LEVEL_2_RESPONSE_EVIDENCE" | "LEVEL_3_CAUSAL";
export type CaseOutcome = "RESOLVED_AFTER_FIRST_PUSH" | "RESOLVED_AFTER_SECOND_PUSH" | "RESOLVED_AFTER_ESCALATION" | "STILL_UNRESOLVED" | "SUPPRESSED" | "MISSING_EVIDENCE";
export type SuppressionStatus = "CURRENT" | "HISTORICAL" | "NONE" | "UNKNOWN" | "AMBIGUOUS";
export type DispatchEvidenceLevel = "LEVEL_A_CASE_ACTION" | "LEVEL_B_BATCH_MEMBERSHIP" | "LEVEL_C_MESSAGE_ONLY" | "LEVEL_D_PENDING_ONLY" | "NONE";

export interface SuppressionEvidence {
  source: "ORDER_EXCEPTION" | "RILLNET_CHANGE_PAUSED" | "EXTERNAL_POLICY";
  reason: string;
  status: "CURRENT" | "HISTORICAL" | "NONE" | "UNKNOWN";
  observedAt?: string;
  expiresAt?: string | null;
}

export interface SuppressionResolution {
  status: SuppressionStatus;
  currentReasons: string[];
  historicalReasons: string[];
}

export interface CaseValueTrace {
  caseId: string;
  incidentKey: string;
  detectedAt: string;
  firstPushConfirmedAt: string | null;
  secondPushConfirmedAt: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  outcome: CaseOutcome;
  attribution: AttributionLevel;
  suppression: SuppressionResolution;
  firstPushEvidenceLevel: DispatchEvidenceLevel;
  secondPushEvidenceLevel: DispatchEvidenceLevel;
  escalationEvidenceLevel: DispatchEvidenceLevel;
  invalidStageActions: number;
  duplicateActionsPrevented: number;
}

export interface BusinessValueMetrics {
  totalDetected: number;
  totalActionable: number;
  firstPushConfirmed: number;
  firstPushResolutionCount: number;
  firstPushResolutionRate: number | null;
  secondPushRequired: number;
  secondPushConfirmed: number;
  secondPushResolutionCount: number;
  secondPushResolutionRate: number | null;
  escalationRequired: number;
  escalated: number;
  escalationResolutionCount: number;
  stillUnresolved: number;
  suppressedCases: number;
  duplicateActionsPrevented: number;
  invalidStageActions: number;
  medianTimeToFirstPushHours: number | null;
  medianTimeToResolutionHours: number | null;
  medianTimeAfterFirstPushHours: number | null;
  medianTimeAfterSecondPushHours: number | null;
}

export interface BusinessValueReport {
  metrics: BusinessValueMetrics;
  cases: CaseValueTrace[];
}

/** Owner supplied only: V0 intentionally provides no invented defaults. */
export interface ValueModelOwnerInput {
  value: number | null;
  unit: "minutes_per_case" | "currency_per_hour" | "currency_per_sla_unit";
  acceptableRange: { minExclusive: number; maxInclusive?: number };
  evidenceRequired: string;
  mandatory: boolean;
}

export interface ValueModelOwnerInputs {
  MANUAL_REVIEW_MINUTES_PER_CASE: ValueModelOwnerInput;
  MANUAL_FOLLOWUP_MINUTES_PER_CASE: ValueModelOwnerInput;
  LABOR_COST_PER_HOUR: ValueModelOwnerInput;
  ESCALATION_HANDLING_MINUTES: ValueModelOwnerInput;
  OPTIONAL_SLA_COST_PARAMETER: ValueModelOwnerInput;
}

const time = (value: string | null | undefined): number | null => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};
const isoMin = (values: Array<string | null | undefined>): string | null => {
  const valid = values.filter((value): value is string => time(value) !== null);
  return valid.sort((a, b) => time(a)! - time(b)!)[0] ?? null;
};
const hours = (start: string | null, end: string | null): number | null => {
  const from = time(start); const to = time(end);
  return from === null || to === null || to < from ? null : (to - from) / 3_600_000;
};
const median = (values: Array<number | null>): number | null => {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const strongestEvidenceLevel = (levels: DispatchEvidenceLevel[]): DispatchEvidenceLevel => {
  const order: DispatchEvidenceLevel[] = ["LEVEL_A_CASE_ACTION", "LEVEL_B_BATCH_MEMBERSHIP", "LEVEL_C_MESSAGE_ONLY", "LEVEL_D_PENDING_ONLY", "NONE"];
  return order.find(level => levels.includes(level)) ?? "NONE";
};

/**
 * Resolves only supplied durable suppression evidence. Absence of an action is
 * never evidence of suppression; an incomplete read remains UNKNOWN.
 */
export function resolveSuppressionEvidence(caseEvidence: BusinessValueCaseEvidence): SuppressionResolution {
  const at = time(caseEvidence.referenceTime) ?? Date.now();
  const observations = [...(caseEvidence.suppressionEvidence ?? [])];
  if (caseEvidence.followupCase.current_state === "RILLNET_CHANGE_PAUSED") {
    observations.push({ source: "RILLNET_CHANGE_PAUSED", reason: "RILLNET_STATUS_CHANGED", status: "CURRENT", observedAt: caseEvidence.followupCase.rillnet_changed_at ?? undefined });
  }
  const orderCodes = new Set(caseEvidence.caseOrderCodes ?? []);
  for (const exception of caseEvidence.orderExceptions ?? []) {
    if (orderCodes.size && !orderCodes.has(exception.order_code)) continue;
    const expiry = time(exception.expires_at);
    observations.push({ source: "ORDER_EXCEPTION", reason: exception.reason_code, status: expiry !== null && expiry <= at ? "HISTORICAL" : "CURRENT", expiresAt: exception.expires_at });
  }
  const currentReasons = [...new Set(observations.filter(item => item.status === "CURRENT").map(item => item.reason))];
  const historicalReasons = [...new Set(observations.filter(item => item.status === "HISTORICAL").map(item => item.reason))];
  const hasUnknown = observations.some(item => item.status === "UNKNOWN");
  const hasExplicitNone = observations.some(item => item.status === "NONE");
  if (currentReasons.length && (hasUnknown || hasExplicitNone)) return { status: "AMBIGUOUS", currentReasons, historicalReasons };
  if (currentReasons.length) return { status: "CURRENT", currentReasons, historicalReasons };
  if (hasUnknown || caseEvidence.suppressionEvidenceComplete !== true) return { status: "UNKNOWN", currentReasons, historicalReasons };
  return { status: historicalReasons.length ? "HISTORICAL" : "NONE", currentReasons, historicalReasons };
}

function actionEvidenceLevel(caseEvidence: BusinessValueCaseEvidence, action: NotificationActionRow, events: NotificationActionEventRow[]): DispatchEvidenceLevel {
  const payloadIncidentId = String(action.payload?.incidentId ?? action.payload?.incident_id ?? "");
  const caseLinked = payloadIncidentId === caseEvidence.followupCase.incident_id;
  const deliveredEvent = events.some(event => event.action_id === action.id && event.event_type === "DELIVERY_SUCCEEDED");
  const deliveredRecord = action.outcome === "DELIVERED" && Boolean(action.provider_message_id || deliveredEvent);
  if (caseLinked && deliveredRecord) return "LEVEL_A_CASE_ACTION";
  if (caseLinked) return "LEVEL_D_PENDING_ONLY";
  if (deliveredRecord) return "LEVEL_C_MESSAGE_ONLY";
  return "NONE";
}

function actionTime(action: NotificationActionRow, events: NotificationActionEventRow[]): string | null {
  const delivery = events.filter(event => event.action_id === action.id && event.event_type === "DELIVERY_SUCCEEDED").map(event => event.created_at);
  return isoMin([...delivery, action.processed_at, action.updated_at, action.created_at]);
}

/**
 * Computes only defensible observed metrics. Pending/generated actions are
 * never treated as confirmed, and missing timestamps stay N/A.
 */
export function buildBusinessValueReport(evidence: BusinessValueCaseEvidence[]): BusinessValueReport {
  const traces = evidence.map(item => {
    const actions = item.actions ?? [];
    const events = item.actionEvents ?? [];
    const confirmed = (type: NotificationActionRow["action_type"]) => actions
      .filter(action => action.action_type === type && actionEvidenceLevel(item, action, events) === "LEVEL_A_CASE_ACTION")
      .map(action => actionTime(action, events));
    const firstPushEvidenceLevel = strongestEvidenceLevel(actions.filter(action => action.action_type === "FIRST_PUSH").map(action => actionEvidenceLevel(item, action, events)));
    const secondPushEvidenceLevel = strongestEvidenceLevel(actions.filter(action => action.action_type === "SECOND_PUSH").map(action => actionEvidenceLevel(item, action, events)));
    const escalationEvidenceLevel = strongestEvidenceLevel(actions.filter(action => action.action_type === "ESCALATION").map(action => actionEvidenceLevel(item, action, events)));
    const firstPushConfirmedAt = isoMin(confirmed("FIRST_PUSH"));
    const secondPushConfirmedAt = isoMin(confirmed("SECOND_PUSH"));
    const escalatedAt = isoMin(confirmed("ESCALATION"));
    const resolvedAt = item.followupCase.resolved_at ?? (item.followupCase.current_state === "RESOLVED" || item.followupCase.current_state === "CLOSED" ? null : null);
    const duplicateActionsPrevented = events.filter(event => event.event_type === "ACTION_DEDUPLICATED").length;
    const invalidStageActions =
      (secondPushConfirmedAt && (!firstPushConfirmedAt || time(secondPushConfirmedAt)! < time(firstPushConfirmedAt)!) ? 1 : 0) +
      (escalatedAt && (!secondPushConfirmedAt || time(escalatedAt)! < time(secondPushConfirmedAt)!) ? 1 : 0);
    const suppression = resolveSuppressionEvidence(item);
    const hasResolution = resolvedAt !== null;
    const outcome: CaseOutcome = suppression.status === "CURRENT" ? "SUPPRESSED"
      : hasResolution && escalatedAt && time(escalatedAt)! <= time(resolvedAt)! ? "RESOLVED_AFTER_ESCALATION"
      : hasResolution && secondPushConfirmedAt && time(secondPushConfirmedAt)! <= time(resolvedAt)! ? "RESOLVED_AFTER_SECOND_PUSH"
      : hasResolution && firstPushConfirmedAt && time(firstPushConfirmedAt)! <= time(resolvedAt)! ? "RESOLVED_AFTER_FIRST_PUSH"
      : hasResolution ? "MISSING_EVIDENCE"
      : "STILL_UNRESOLVED";
    const attribution: AttributionLevel = outcome === "MISSING_EVIDENCE" ? "LEVEL_0_TEMPORAL"
      : outcome.startsWith("RESOLVED_AFTER") ? "LEVEL_1_GOVERNED_WINDOW" : "LEVEL_0_TEMPORAL";
    return {
      caseId: item.followupCase.id, incidentKey: item.followupCase.incident_key,
      detectedAt: item.incident?.first_detected_at ?? item.followupCase.first_detected_at,
      firstPushConfirmedAt, secondPushConfirmedAt, escalatedAt, resolvedAt,
      outcome, attribution, suppression, firstPushEvidenceLevel, secondPushEvidenceLevel, escalationEvidenceLevel, invalidStageActions, duplicateActionsPrevented,
    } satisfies CaseValueTrace;
  });
  const active = traces.filter(trace => trace.suppression.status === "NONE");
  const count = (outcome: CaseOutcome) => traces.filter(trace => trace.outcome === outcome).length;
  const firstConfirmed = active.filter(trace => trace.firstPushConfirmedAt);
  const secondConfirmed = active.filter(trace => trace.secondPushConfirmedAt);
  const metrics: BusinessValueMetrics = {
    totalDetected: traces.length,
    totalActionable: active.length,
    firstPushConfirmed: firstConfirmed.length,
    firstPushResolutionCount: count("RESOLVED_AFTER_FIRST_PUSH"),
    firstPushResolutionRate: firstConfirmed.length ? count("RESOLVED_AFTER_FIRST_PUSH") / firstConfirmed.length : null,
    secondPushRequired: active.filter(trace => trace.secondPushConfirmedAt || trace.outcome === "RESOLVED_AFTER_SECOND_PUSH").length,
    secondPushConfirmed: secondConfirmed.length,
    secondPushResolutionCount: count("RESOLVED_AFTER_SECOND_PUSH"),
    secondPushResolutionRate: secondConfirmed.length ? count("RESOLVED_AFTER_SECOND_PUSH") / secondConfirmed.length : null,
    escalationRequired: active.filter(trace => trace.escalatedAt || trace.outcome === "RESOLVED_AFTER_ESCALATION").length,
    escalated: active.filter(trace => trace.escalatedAt).length,
    escalationResolutionCount: count("RESOLVED_AFTER_ESCALATION"),
    stillUnresolved: count("STILL_UNRESOLVED"),
    suppressedCases: count("SUPPRESSED"),
    duplicateActionsPrevented: traces.reduce((sum, trace) => sum + trace.duplicateActionsPrevented, 0),
    invalidStageActions: traces.reduce((sum, trace) => sum + trace.invalidStageActions, 0),
    medianTimeToFirstPushHours: median(firstConfirmed.map(trace => hours(trace.detectedAt, trace.firstPushConfirmedAt))),
    medianTimeToResolutionHours: median(traces.map(trace => hours(trace.detectedAt, trace.resolvedAt))),
    medianTimeAfterFirstPushHours: median(traces.map(trace => hours(trace.firstPushConfirmedAt, trace.resolvedAt))),
    medianTimeAfterSecondPushHours: median(traces.map(trace => hours(trace.secondPushConfirmedAt, trace.resolvedAt))),
  };
  return { metrics, cases: traces };
}
