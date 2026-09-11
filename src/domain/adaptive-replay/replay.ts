import { evaluateV2Snapshot, reconstructV1Action, snapshotCaseAt, type AdaptiveCaseSnapshot, type ReplayComparison, type WaitSafety } from "./normalizer";
import type { CaseEvidenceRecord } from "@/domain/historical-evidence/reader";

export interface ReplayCaseResult { snapshot: AdaptiveCaseSnapshot; v1: ReturnType<typeof reconstructV1Action>; v2: ReturnType<typeof evaluateV2Snapshot>; comparison: ReplayComparison; waitSafety: WaitSafety; laterObservedOutcome: string; }
export interface BaselineReplaySummary {
  totalSnapshots: number; v1ActionCount: number; v2ActNow: number; v2Wait: number; v2RequestInformation: number; v2Escalate: number; v2Close: number;
  sameAction: number; v2NotificationsAvoided: number; notificationReductionRate: number | null; v2EscalatesInsteadOfRepeat: number; v2IntervenesEarlier: number; v2IntervenesLater: number; v2PotentialMiss: number;
  safeWait: number; questionableWait: number; unsafeWait: number; insufficientEvidence: number;
  totalConfirmedV1Interventions: number; repeatInterventionsWithNoMaterialChange: number | null; sameRecipientRepeatCount: number | null; interventionsFollowedByOperatorResponse: number | null; interventionsFollowedByProgress: number | null; interventionsWithNoObservedChange: number | null;
}
export interface ReplayReviewPack { avoidsNotification: ReplayCaseResult[]; waitsForValidProgress: ReplayCaseResult[]; escalatesInsteadOfRepeat: ReplayCaseResult[]; potentialMisses: ReplayCaseResult[]; unsafeWaits: ReplayCaseResult[]; insufficientEvidence: ReplayCaseResult[]; }
const ms = (value: string | null | undefined) => Date.parse(value ?? "");

export function classifyReplay(snapshot: AdaptiveCaseSnapshot, v1: ReplayCaseResult["v1"], v2: ReplayCaseResult["v2"]): ReplayComparison {
  if (snapshot.evidenceQuality.quality !== "COMPLETE" || v1.action === "UNKNOWN") return "INSUFFICIENT_EVIDENCE";
  if ((v1.action === "CLOSE" && v2.decision === "CLOSE") || ((v1.action === "FIRST_PUSH" || v1.action === "SECOND_PUSH") && v2.decision === "ACT_NOW")) return "SAME_ACTION";
  if ((v1.action === "FIRST_PUSH" || v1.action === "SECOND_PUSH") && v2.decision === "WAIT") {
    if (v2.reasonCode === "DELIVERY_PROGRESSING_WITH_ETA" || v2.reasonCode === "VALID_OPERATOR_COMMITMENT" || v2.reasonCode === "BACKLOG_IMPROVING") return "V2_WAITS_FOR_VALID_PROGRESS";
    return "V2_POTENTIAL_MISS";
  }
  if ((v1.action === "FIRST_PUSH" || v1.action === "SECOND_PUSH") && v2.decision === "ESCALATE") return "V2_ESCALATES_INSTEAD_OF_REPEAT";
  if (v1.action === "NO_ACTION" && v2.decision === "ACT_NOW") return "V2_INTERVENES_EARLIER";
  if (v1.action !== "NO_ACTION" && v2.decision === "REQUEST_INFORMATION") return "V2_REQUESTS_NEEDED_INFORMATION";
  if (v1.action !== "NO_ACTION" && v2.decision === "CLOSE") return "V2_POTENTIAL_MISS";
  return "UNKNOWN";
}

export function reviewWait(record: CaseEvidenceRecord, snapshot: AdaptiveCaseSnapshot, v2: ReplayCaseResult["v2"]): { safety: WaitSafety; outcome: string } {
  if (v2.decision !== "WAIT") return { safety: "NOT_APPLICABLE", outcome: "NOT_APPLICABLE" };
  if (!v2.nextCheckAt) return { safety: "UNSAFE_WAIT", outcome: "WAIT_WITHOUT_NEXT_CHECK" };
  const until = ms(v2.nextCheckAt); const later = record.incidentHistory.filter(item => ms(item.recordedAt) > ms(snapshot.time.observedAt) && ms(item.recordedAt) <= until).sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt));
  if (!later.length) return { safety: "OUTCOME_UNKNOWN", outcome: "NO_RETAINED_OUTCOME_BEFORE_NEXT_CHECK" };
  const baseline = snapshot.backlog.currentAffectedOrders;
  if (later.some(item => item.affectedOrderCount === 0)) return { safety: "SAFE_WAIT", outcome: "RESOLVED_BEFORE_NEXT_CHECK" };
  if (baseline !== null && later.some(item => item.affectedOrderCount > baseline)) return { safety: "UNSAFE_WAIT", outcome: "BACKLOG_INCREASED_BEFORE_NEXT_CHECK" };
  if (snapshot.time.slaDeadlineAt && until > ms(snapshot.time.slaDeadlineAt)) return { safety: "QUESTIONABLE_WAIT", outcome: "NEXT_CHECK_AFTER_KNOWN_DEADLINE" };
  return { safety: "QUESTIONABLE_WAIT", outcome: "NO_RESOLUTION_OR_DETERIORATION_OBSERVED" };
}

/** Pure baseline replay: records and supplemental facts are caller-provided read evidence. */
export function replayAdaptiveBaseline(input: Array<{ record: CaseEvidenceRecord; observedAt: string }>): ReplayCaseResult[] {
  return input.map(({ record, observedAt }) => {
    const snapshot = snapshotCaseAt(record, observedAt); const v1 = reconstructV1Action(record, observedAt); const v2 = evaluateV2Snapshot(snapshot);
    const comparison = classifyReplay(snapshot, v1, v2); const reviewed = reviewWait(record, snapshot, v2);
    return { snapshot, v1, v2, comparison, waitSafety: reviewed.safety, laterObservedOutcome: reviewed.outcome };
  });
}

/** Aggregates retained facts only. Null represents evidence the current reader does not retain. */
export function summarizeBaselineReplay(results: ReplayCaseResult[], records: CaseEvidenceRecord[]): BaselineReplaySummary {
  const n = (predicate: (item: ReplayCaseResult) => boolean) => results.filter(predicate).length;
  const v1ActionCount = n(item => ["FIRST_PUSH", "SECOND_PUSH", "ESCALATE"].includes(item.v1.action));
  const confirmed = records.flatMap(record => record.actions).filter(action => action.caseConfirmation === "CONFIRMED").length;
  const avoided = n(item => ["FIRST_PUSH", "SECOND_PUSH", "ESCALATE"].includes(item.v1.action) && item.v2.decision === "WAIT");
  return {
    totalSnapshots: results.length, v1ActionCount, v2ActNow: n(item => item.v2.decision === "ACT_NOW"), v2Wait: n(item => item.v2.decision === "WAIT"), v2RequestInformation: n(item => item.v2.decision === "REQUEST_INFORMATION"), v2Escalate: n(item => item.v2.decision === "ESCALATE"), v2Close: n(item => item.v2.decision === "CLOSE"),
    sameAction: n(item => item.comparison === "SAME_ACTION"), v2NotificationsAvoided: avoided, notificationReductionRate: v1ActionCount ? avoided / v1ActionCount : null, v2EscalatesInsteadOfRepeat: n(item => item.comparison === "V2_ESCALATES_INSTEAD_OF_REPEAT"), v2IntervenesEarlier: n(item => item.comparison === "V2_INTERVENES_EARLIER"), v2IntervenesLater: n(item => item.comparison === "V2_INTERVENES_LATER"), v2PotentialMiss: n(item => item.comparison === "V2_POTENTIAL_MISS"),
    safeWait: n(item => item.waitSafety === "SAFE_WAIT"), questionableWait: n(item => item.waitSafety === "QUESTIONABLE_WAIT"), unsafeWait: n(item => item.waitSafety === "UNSAFE_WAIT"), insufficientEvidence: n(item => item.comparison === "INSUFFICIENT_EVIDENCE"),
    totalConfirmedV1Interventions: confirmed, repeatInterventionsWithNoMaterialChange: null, sameRecipientRepeatCount: null, interventionsFollowedByOperatorResponse: null, interventionsFollowedByProgress: null, interventionsWithNoObservedChange: null,
  };
}

/** PII-minimized case review selections. All safety-critical categories remain unbounded. */
export function buildReplayReviewPack(results: ReplayCaseResult[]): ReplayReviewPack {
  const by = (comparison: ReplayComparison) => results.filter(item => item.comparison === comparison).slice(0, 5);
  return { avoidsNotification: by("V2_AVOIDS_UNNECESSARY_NOTIFICATION"), waitsForValidProgress: by("V2_WAITS_FOR_VALID_PROGRESS"), escalatesInsteadOfRepeat: by("V2_ESCALATES_INSTEAD_OF_REPEAT"), potentialMisses: results.filter(item => item.comparison === "V2_POTENTIAL_MISS"), unsafeWaits: results.filter(item => item.waitSafety === "UNSAFE_WAIT"), insufficientEvidence: results.filter(item => item.comparison === "INSUFFICIENT_EVIDENCE") };
}
