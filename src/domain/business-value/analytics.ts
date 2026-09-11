import type { FollowupCaseRow, FollowupEventRow, IncidentRow } from "@/connectors/supabase/types";
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
  /** An externally-established valid exception; absent means evidence is unknown, not suppressed. */
  suppressionReason?: string | null;
  scope?: { province?: string | null; warehouseId?: string | null; warehouseName?: string | null };
}

export type AttributionLevel = "LEVEL_0_TEMPORAL" | "LEVEL_1_GOVERNED_WINDOW" | "LEVEL_2_RESPONSE_EVIDENCE" | "LEVEL_3_CAUSAL";
export type CaseOutcome = "RESOLVED_AFTER_FIRST_PUSH" | "RESOLVED_AFTER_SECOND_PUSH" | "RESOLVED_AFTER_ESCALATION" | "STILL_UNRESOLVED" | "SUPPRESSED" | "MISSING_EVIDENCE";

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
  suppressionReason: string | null;
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

function actionConfirmed(action: NotificationActionRow, events: NotificationActionEventRow[]): boolean {
  if (action.outcome === "DELIVERED" && action.status === "SENT") return true;
  return events.some(event => event.action_id === action.id && event.event_type === "DELIVERY_SUCCEEDED");
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
      .filter(action => action.action_type === type && actionConfirmed(action, events))
      .map(action => actionTime(action, events));
    const firstPushConfirmedAt = isoMin(confirmed("FIRST_PUSH"));
    const secondPushConfirmedAt = isoMin(confirmed("SECOND_PUSH"));
    const escalatedAt = isoMin(confirmed("ESCALATION"));
    const resolvedAt = item.followupCase.resolved_at ?? (item.followupCase.current_state === "RESOLVED" || item.followupCase.current_state === "CLOSED" ? null : null);
    const duplicateActionsPrevented = events.filter(event => event.event_type === "ACTION_DEDUPLICATED").length;
    const invalidStageActions =
      (secondPushConfirmedAt && (!firstPushConfirmedAt || time(secondPushConfirmedAt)! < time(firstPushConfirmedAt)!) ? 1 : 0) +
      (escalatedAt && (!secondPushConfirmedAt || time(escalatedAt)! < time(secondPushConfirmedAt)!) ? 1 : 0);
    const suppressionReason = item.suppressionReason ?? null;
    const hasResolution = resolvedAt !== null;
    const outcome: CaseOutcome = suppressionReason ? "SUPPRESSED"
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
      outcome, attribution, suppressionReason, invalidStageActions, duplicateActionsPrevented,
    } satisfies CaseValueTrace;
  });
  const active = traces.filter(trace => !trace.suppressionReason);
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
