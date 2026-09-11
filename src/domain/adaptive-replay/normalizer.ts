import type { CaseEvidenceRecord, HistoricalActionEvidence } from "@/domain/historical-evidence/reader";
import { decideAdaptiveIntervention } from "@/domain/adaptive-intervention/engine";
import type { AdaptiveInterventionDecision, AdaptiveInterventionState, V1Decision } from "@/domain/adaptive-intervention/types";

export type SnapshotQuality = "COMPLETE" | "PARTIAL" | "HISTORICAL_STATE_UNAVAILABLE";
export type SnapshotTrend = "INCREASING" | "DECREASING" | "STABLE" | "UNKNOWN";
export type CommitmentStatus = "NO_COMMITMENT" | "ACTIVE_COMMITMENT" | "EXPIRED_COMMITMENT" | "AMBIGUOUS_COMMITMENT" | "UNKNOWN";
export type EtaEvidenceLevel = "A_TRUSTED_OPERATIONAL" | "B_STRUCTURED_OPERATOR" | "C_DERIVED" | "D_UNSTRUCTURED" | "NONE" | "UNKNOWN";
export type EvidenceConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type ReconstructedV1Action = "NO_ACTION" | "FIRST_PUSH" | "SECOND_PUSH" | "ESCALATE" | "CLOSE" | "UNKNOWN";
export type ReplayComparison = "SAME_ACTION" | "V2_AVOIDS_UNNECESSARY_NOTIFICATION" | "V2_WAITS_FOR_VALID_PROGRESS" | "V2_REQUESTS_NEEDED_INFORMATION" | "V2_ESCALATES_INSTEAD_OF_REPEAT" | "V2_INTERVENES_EARLIER" | "V2_INTERVENES_LATER" | "V2_POTENTIAL_MISS" | "V1_POTENTIAL_OVERNOTIFICATION" | "INSUFFICIENT_EVIDENCE" | "UNKNOWN";
export type WaitSafety = "SAFE_WAIT" | "QUESTIONABLE_WAIT" | "UNSAFE_WAIT" | "OUTCOME_UNKNOWN" | "NOT_APPLICABLE";

/** The sole production-evidence boundary for V2 replay. Unknown is explicit, never inferred safe. */
export interface AdaptiveCaseSnapshot {
  identity: { caseId: string; incidentId: string; warehouseId: string; province: string | null; region: string | null; issueType: string | null };
  time: { observedAt: string; detectedAt: string | null; slaDeadlineAt: string | null; backlogAgeMinutes: number | null };
  backlog: { currentAffectedOrders: number | null; previousAffectedOrders: number | null; trend: SnapshotTrend; meaningfulProgress: boolean | null };
  delivery: { routeAssigned: boolean | null; driverAssigned: boolean | null; deliveryInProgress: boolean | null; latestOperationalEventAt: string | null };
  exception: { suppressionState: "NONE" | "ACTIVE" | "EXPIRED" | "UNKNOWN"; suppressionReason: string | null; expiresAt: string | null; confidence: EvidenceConfidence };
  intervention: { confirmedFirstInterventionAt: string | null; confirmedSecondInterventionAt: string | null; lastInterventionAt: string | null; interventionCountToday: number | null; escalationHistory: boolean | null };
  operatorResponse: { status: CommitmentStatus; commitmentAt: string | null; committedCompletionAt: string | null; structuredReason: string | null; source: string | null };
  eta: { etaAt: string | null; source: string | null; evidenceLevel: EtaEvidenceLevel; confidence: EvidenceConfidence; expired: boolean | null };
  evidenceQuality: { quality: SnapshotQuality; completeness: EvidenceConfidence; missingFields: string[]; ambiguousFields: string[] };
}

/** Optional additions from a future structured, read-only operational reader. */
export interface StructuredReplayEvidence {
  slaDeadlineAt?: string | null;
  routeAssigned?: boolean | null; driverAssigned?: boolean | null; deliveryInProgress?: boolean | null;
  commitment?: { recordedAt: string; committedCompletionAt: string; actor: string; source: string; structuredReason?: string | null } | null;
  eta?: { recordedAt: string; etaAt: string; source: string; evidenceLevel: EtaEvidenceLevel } | null;
}

const millis = (value: string | null | undefined) => Date.parse(value ?? "");
const beforeOrAt = (value: string | null | undefined, observedAt: string) => Number.isFinite(millis(value)) && millis(value) <= millis(observedAt);
const day = (value: string) => value.slice(0, 10);
const confirmed = (action: HistoricalActionEvidence, observedAt: string) => action.caseConfirmation === "CONFIRMED" && beforeOrAt(action.confirmedAt, observedAt);
const isTrustedEta = (level: EtaEvidenceLevel) => level === "A_TRUSTED_OPERATIONAL" || level === "B_STRUCTURED_OPERATOR";

/**
 * Reconstructs only with facts timestamped at or before observedAt. Current
 * followup row state is deliberately ignored, because it is mutable.
 */
export function snapshotCaseAt(record: CaseEvidenceRecord, observedAt: string, extra: StructuredReplayEvidence = {}): AdaptiveCaseSnapshot {
  const missing = new Set<string>(); const ambiguous = new Set<string>();
  if (record.historicalState === "HISTORICAL_STATE_UNAVAILABLE") missing.add("INCIDENT_HISTORY_AT_OBSERVATION");
  const history = record.incidentHistory.filter(item => beforeOrAt(item.recordedAt, observedAt)).sort((a, b) => millis(a.recordedAt) - millis(b.recordedAt));
  if (!history.length) missing.add("AFFECTED_ORDER_HISTORY");
  const current = history.at(-1) ?? null; const previous = history.length > 1 ? history.at(-2)! : null;
  const currentCount = current?.affectedOrderCount ?? null; const previousCount = previous?.affectedOrderCount ?? null;
  const decrease = currentCount !== null && previousCount !== null && previousCount > 0 ? (previousCount - currentCount) / previousCount : null;
  const trend: SnapshotTrend = decrease === null ? "UNKNOWN" : decrease > 0 ? "DECREASING" : decrease < 0 ? "INCREASING" : "STABLE";
  const events = record.followupEvents.filter(item => beforeOrAt(item.eventTime, observedAt));
  const actions = record.actions.filter(item => beforeOrAt(item.createdAt, observedAt));
  const confirmedActions = actions.filter(item => confirmed(item, observedAt));
  const lastAction = [...confirmedActions].sort((a, b) => millis(b.confirmedAt) - millis(a.confirmedAt))[0] ?? null;
  const activeSuppression = record.suppressionEvidence.filter(item => beforeOrAt(item.createdAt, observedAt) && (!item.expiresAt || millis(item.expiresAt) > millis(observedAt)));
  const historicalSuppression = record.suppressionEvidence.filter(item => beforeOrAt(item.createdAt, observedAt) && item.expiresAt && millis(item.expiresAt) <= millis(observedAt));
  if (activeSuppression.length > 1) ambiguous.add("SUPPRESSION_MULTIPLE");
  const commitment = extra.commitment && beforeOrAt(extra.commitment.recordedAt, observedAt) ? extra.commitment : null;
  const commitmentStatus: CommitmentStatus = extra.commitment && !commitment ? "UNKNOWN" : !commitment ? "NO_COMMITMENT" : millis(commitment.committedCompletionAt) > millis(observedAt) ? "ACTIVE_COMMITMENT" : "EXPIRED_COMMITMENT";
  if (!commitment && extra.commitment) missing.add("COMMITMENT_AT_OBSERVATION");
  const eta = extra.eta && beforeOrAt(extra.eta.recordedAt, observedAt) ? extra.eta : null;
  const etaExpired = eta ? millis(eta.etaAt) <= millis(observedAt) : null;
  if (extra.eta && !eta) missing.add("ETA_AT_OBSERVATION");
  if (!extra.slaDeadlineAt) missing.add("SLA_DEADLINE");
  if (extra.deliveryInProgress === undefined) missing.add("DELIVERY_PROGRESS");
  const quality: SnapshotQuality = record.historicalState === "HISTORICAL_STATE_UNAVAILABLE" ? "HISTORICAL_STATE_UNAVAILABLE" : missing.size ? "PARTIAL" : "COMPLETE";
  const detectedAt = beforeOrAt(record.detectedAt, observedAt) ? record.detectedAt : null;
  return {
    identity: { caseId: record.caseId, incidentId: record.incidentId, warehouseId: record.warehouseId, province: record.province, region: record.region, issueType: record.issueType },
    time: { observedAt, detectedAt, slaDeadlineAt: extra.slaDeadlineAt ?? null, backlogAgeMinutes: detectedAt ? Math.max(0, (millis(observedAt) - millis(detectedAt)) / 60_000) : null },
    backlog: { currentAffectedOrders: currentCount, previousAffectedOrders: previousCount, trend, meaningfulProgress: decrease === null ? null : decrease >= 0.2 },
    delivery: { routeAssigned: extra.routeAssigned ?? null, driverAssigned: extra.driverAssigned ?? null, deliveryInProgress: extra.deliveryInProgress ?? null, latestOperationalEventAt: events.at(-1)?.eventTime ?? current?.recordedAt ?? null },
    exception: activeSuppression.length ? { suppressionState: "ACTIVE", suppressionReason: activeSuppression[0].reason, expiresAt: activeSuppression[0].expiresAt, confidence: ambiguous.size ? "LOW" : "HIGH" } : historicalSuppression.length ? { suppressionState: "EXPIRED", suppressionReason: historicalSuppression[0].reason, expiresAt: historicalSuppression[0].expiresAt, confidence: "HIGH" } : { suppressionState: "NONE", suppressionReason: null, expiresAt: null, confidence: "HIGH" },
    intervention: { confirmedFirstInterventionAt: confirmedActions.find(item => item.actionType === "FIRST_PUSH")?.confirmedAt ?? null, confirmedSecondInterventionAt: confirmedActions.find(item => item.actionType === "SECOND_PUSH")?.confirmedAt ?? null, lastInterventionAt: lastAction?.confirmedAt ?? null, interventionCountToday: confirmedActions.filter(item => item.confirmedAt && day(item.confirmedAt) === day(observedAt)).length, escalationHistory: confirmedActions.some(item => item.actionType === "ESCALATION") },
    operatorResponse: { status: commitmentStatus, commitmentAt: commitment?.recordedAt ?? null, committedCompletionAt: commitment?.committedCompletionAt ?? null, structuredReason: commitment?.structuredReason ?? null, source: commitment?.source ?? null },
    eta: { etaAt: eta?.etaAt ?? null, source: eta?.source ?? null, evidenceLevel: eta?.evidenceLevel ?? "NONE", confidence: !eta ? "UNKNOWN" : isTrustedEta(eta.evidenceLevel) ? "HIGH" : "LOW", expired: etaExpired },
    evidenceQuality: { quality, completeness: quality === "COMPLETE" ? "HIGH" : quality === "PARTIAL" ? "LOW" : "UNKNOWN", missingFields: [...missing].sort(), ambiguousFields: [...ambiguous].sort() },
  };
}

/** Converts the canonical snapshot to the unchanged V2 core input in memory. */
export function snapshotToV2State(snapshot: AdaptiveCaseSnapshot): AdaptiveInterventionState {
  const interventions = [snapshot.intervention.confirmedFirstInterventionAt && { type: "FIRST_INTERVENTION" as const, at: snapshot.intervention.confirmedFirstInterventionAt, confirmed: true }, snapshot.intervention.confirmedSecondInterventionAt && { type: "REMINDER" as const, at: snapshot.intervention.confirmedSecondInterventionAt, confirmed: true }].filter(Boolean) as AdaptiveInterventionState["interventions"];
  const trustedEta = snapshot.eta.etaAt && snapshot.eta.expired === false && isTrustedEta(snapshot.eta.evidenceLevel) ? snapshot.eta.etaAt : undefined;
  return { caseId: snapshot.identity.caseId, incidentKey: snapshot.identity.incidentId, observedAt: snapshot.time.observedAt, issueType: snapshot.identity.issueType ?? undefined, resolved: snapshot.backlog.currentAffectedOrders === 0, affectedOrderCount: snapshot.backlog.currentAffectedOrders ?? undefined, previousAffectedOrderCount: snapshot.backlog.previousAffectedOrders ?? undefined, backlogAgeMinutes: snapshot.time.backlogAgeMinutes ?? undefined, slaDeadlineAt: snapshot.time.slaDeadlineAt ?? undefined, routeCreated: snapshot.delivery.routeAssigned ?? undefined, driverAssigned: snapshot.delivery.driverAssigned ?? undefined, deliveryInProgress: snapshot.delivery.deliveryInProgress ?? undefined, deliveryEtaAt: trustedEta, validException: snapshot.exception.suppressionState === "ACTIVE" && snapshot.exception.expiresAt ? { reasonCode: snapshot.exception.suppressionReason ?? "GOVERNED_EXCEPTION", expiresAt: snapshot.exception.expiresAt } : undefined, operatorCommitment: snapshot.operatorResponse.status === "ACTIVE_COMMITMENT" && snapshot.operatorResponse.committedCompletionAt && snapshot.operatorResponse.commitmentAt ? { credible: true, receivedAt: snapshot.operatorResponse.commitmentAt, promisedAt: snapshot.operatorResponse.committedCompletionAt } : undefined, interventions, materialEvents: snapshot.backlog.trend === "DECREASING" ? ["BACKLOG_DECREASED"] : snapshot.backlog.trend === "INCREASING" ? ["BACKLOG_INCREASED"] : [], evidenceComplete: snapshot.evidenceQuality.quality === "COMPLETE" };
}

export function reconstructV1Action(record: CaseEvidenceRecord, observedAt: string): { action: ReconstructedV1Action; reason: string; confidence: "HIGH" | "PARTIAL" | "LOW" } {
  if (record.historicalState === "HISTORICAL_STATE_UNAVAILABLE") return { action: "UNKNOWN", reason: "Historical incident state is unavailable at observation time.", confidence: "LOW" };
  const events = record.followupEvents.filter(item => beforeOrAt(item.eventTime, observedAt)).sort((a, b) => millis(a.eventTime) - millis(b.eventTime));
  if (!events.length) return { action: "UNKNOWN", reason: "No retained dated V1 follow-up event can establish V1 action.", confidence: "LOW" };
  const latest = events.at(-1)!;
  if (latest.newState === "FIRST_PUSH_PENDING") return { action: "FIRST_PUSH", reason: "Retained V1 event requested FIRST_PUSH_PENDING.", confidence: "PARTIAL" };
  if (latest.newState === "SECOND_PUSH_PENDING") return { action: "SECOND_PUSH", reason: "Retained V1 event requested SECOND_PUSH_PENDING.", confidence: "PARTIAL" };
  if (latest.newState === "ESCALATION_PENDING") return { action: "ESCALATE", reason: "Retained V1 event requested ESCALATION_PENDING.", confidence: "PARTIAL" };
  if (latest.newState === "RESOLVED" || latest.newState === "CLOSED") return { action: "CLOSE", reason: `Retained V1 state is ${latest.newState}.`, confidence: "PARTIAL" };
  return { action: "NO_ACTION", reason: `Retained V1 state ${latest.newState} has no action request.`, confidence: "PARTIAL" };
}

export function v1ActionForV2(action: ReconstructedV1Action): V1Decision {
  return action === "FIRST_PUSH" ? "FIRST_PUSH" : action === "SECOND_PUSH" ? "SECOND_PUSH" : action === "ESCALATE" ? "ESCALATION" : action === "CLOSE" ? "CLOSED" : "NONE";
}

export function evaluateV2Snapshot(snapshot: AdaptiveCaseSnapshot): AdaptiveInterventionDecision {
  return decideAdaptiveIntervention(snapshotToV2State(snapshot));
}
