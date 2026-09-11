import {
  DEFAULT_ADAPTIVE_POLICY, type AdaptiveInterventionDecision, type AdaptiveInterventionState, type AdaptivePolicyConfig,
  type AdaptiveRiskLevel, type AdaptiveTarget, type EmployeeTask, type ManagerCaseCategory, type NotificationFatigueState,
} from "./types";

const at = (value?: string): number | null => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};
const afterMinutes = (when: string, minutes: number) => new Date(at(when)! + minutes * 60_000).toISOString();
const isFuture = (value: string | undefined, now: string) => (at(value) ?? -Infinity) > (at(now) ?? Infinity);
const hoursSince = (value: string, now: string) => ((at(now)! - at(value)!) / 3_600_000);

export function hasMaterialStateChange(state: AdaptiveInterventionState): boolean {
  return (state.materialEvents ?? []).length > 0;
}

export function notificationFatigue(state: AdaptiveInterventionState, policy = DEFAULT_ADAPTIVE_POLICY): NotificationFatigueState {
  const confirmed = (state.interventions ?? []).filter(item => item.confirmed);
  if (!confirmed.length) return "NONE";
  const latest = [...confirmed].sort((a, b) => at(b.at)! - at(a.at)!)[0];
  const recent = hoursSince(latest.at, state.observedAt) * 60 < policy.recentInterventionMinutes;
  const unproductive = confirmed.filter(item => !item.responseReceived && !item.producedProgress).length;
  if (confirmed.length >= policy.fatigueInterventionThreshold && unproductive >= policy.fatigueInterventionThreshold) return "HIGH";
  if (confirmed.length >= policy.fatigueInterventionThreshold || (recent && !hasMaterialStateChange(state))) return "ELEVATED";
  return "LOW";
}

export function assessAdaptiveRisk(state: AdaptiveInterventionState, policy = DEFAULT_ADAPTIVE_POLICY): { level: AdaptiveRiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  const minutesToSla = state.slaDeadlineAt && at(state.slaDeadlineAt) !== null ? (at(state.slaDeadlineAt)! - at(state.observedAt)!) / 60_000 : null;
  if (state.deliveryFailed) reasons.push("DELIVERY_FAILED");
  if (minutesToSla !== null && minutesToSla <= policy.criticalRiskSlaMinutes) reasons.push("SLA_CRITICAL");
  if (state.driverAssigned === false) reasons.push("NO_DRIVER_ASSIGNED");
  if ((state.materialEvents ?? []).includes("BACKLOG_INCREASED")) reasons.push("BACKLOG_INCREASING");
  if (minutesToSla !== null && minutesToSla <= policy.highRiskSlaMinutes) reasons.push("SLA_NEAR");
  if (state.backlogAgeMinutes && state.backlogAgeMinutes >= 240) reasons.push("BACKLOG_AGED");
  const ignored = (state.interventions ?? []).filter(item => item.confirmed && !item.responseReceived && !item.producedProgress).length;
  if (ignored) reasons.push("INTERVENTION_IGNORED");
  if (reasons.includes("DELIVERY_FAILED") || reasons.includes("SLA_CRITICAL")) return { level: "CRITICAL", reasons };
  if (reasons.includes("NO_DRIVER_ASSIGNED") || reasons.includes("SLA_NEAR") || reasons.includes("BACKLOG_INCREASING") || ignored >= 2) return { level: "HIGH", reasons };
  if (reasons.includes("BACKLOG_AGED") || ignored) return { level: "MEDIUM", reasons };
  return { level: "LOW", reasons: reasons.length ? reasons : ["NO_HIGH_RISK_SIGNAL"] };
}

const base = (state: AdaptiveInterventionState, policy: AdaptivePolicyConfig) => {
  const exceptionFuture = isFuture(state.validException?.expiresAt, state.observedAt);
  const risk = assessAdaptiveRisk(state, policy);
  const interventions = state.interventions ?? [];
  const suppressionStatus: AdaptiveInterventionDecision["suppressionStatus"] = state.validException ? (exceptionFuture ? "VALID_EXCEPTION" : "EXPIRED_EXCEPTION") : "NONE";
  return {
    risk, previousInterventionCount: interventions.length, fatigue: notificationFatigue(state, policy),
    evidence: ["READ_ONLY_CASE_SNAPSHOT", ...(state.materialEvents ?? []), ...(state.deliveryEtaAt ? ["DELIVERY_ETA"] : []), ...(state.operatorCommitment ? ["OPERATOR_COMMITMENT"] : [])],
    suppressionStatus,
    confidence: state.evidenceComplete === false ? "LOW" as const : "HIGH" as const,
  };
};

function decision(state: AdaptiveInterventionState, policy: AdaptivePolicyConfig, input: Omit<AdaptiveInterventionDecision, "caseId" | "decidedAt" | "previousInterventionCount" | "notificationFatigueState" | "evidenceUsed" | "suppressionStatus" | "confidence" | "riskLevel">): AdaptiveInterventionDecision {
  const shared = base(state, policy);
  return { caseId: state.caseId, decidedAt: state.observedAt, riskLevel: shared.risk.level, confidence: shared.confidence, evidenceUsed: shared.evidence, suppressionStatus: shared.suppressionStatus, previousInterventionCount: shared.previousInterventionCount, notificationFatigueState: shared.fatigue, ...input };
}

/** Deterministic V2 policy. It deliberately returns a proposal only. */
export function decideAdaptiveIntervention(state: AdaptiveInterventionState, override: Partial<AdaptivePolicyConfig> = {}): AdaptiveInterventionDecision {
  const policy = { ...DEFAULT_ADAPTIVE_POLICY, ...override };
  const risk = assessAdaptiveRisk(state, policy);
  const prior = state.interventions ?? [];
  const validException = state.validException && isFuture(state.validException.expiresAt, state.observedAt);
  const validEta = state.deliveryInProgress && isFuture(state.deliveryEtaAt, state.observedAt);
  const validCommitment = state.operatorCommitment?.credible && isFuture(state.operatorCommitment.promisedAt, state.observedAt);
  const decreased = (state.materialEvents ?? []).includes("BACKLOG_DECREASED") && state.affectedOrderCount !== undefined && state.previousAffectedOrderCount !== undefined && state.previousAffectedOrderCount > 0 && ((state.previousAffectedOrderCount - state.affectedOrderCount) / state.previousAffectedOrderCount) * 100 >= policy.meaningfulBacklogDecreasePercent;
  const fatigue = notificationFatigue(state, policy);
  const latest = [...prior].sort((a, b) => at(b.at)! - at(a.at)!)[0];

  if (state.resolved) return decision(state, policy, { decision: "CLOSE", target: "NONE", reasonCode: "CASE_RESOLVED", humanReason: "The underlying issue is resolved; no further intervention is appropriate.", nextCheckAt: null, requiredBy: null });
  if (state.evidenceComplete === false && risk.level !== "CRITICAL") return decision(state, policy, { decision: "REQUEST_INFORMATION", target: "TEAM_LEAD", reasonCode: "EVIDENCE_INCOMPLETE", humanReason: "Required operational evidence is incomplete, so the case cannot safely be treated as progressing.", nextCheckAt: afterMinutes(state.observedAt, policy.highRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null, recommendedActionType: "REQUEST_STATUS", recommendedChannel: "EMPLOYEE_INBOX" });
  if (validException) return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "VALID_EXCEPTION", humanReason: "A governed exception is active; re-evaluate when it expires.", nextCheckAt: state.validException!.expiresAt, requiredBy: state.validException!.expiresAt });
  if (validEta && risk.level !== "CRITICAL") return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "DELIVERY_PROGRESSING_WITH_ETA", humanReason: "Delivery is in progress with a credible ETA while SLA risk remains acceptable.", nextCheckAt: afterMinutes(state.deliveryEtaAt!, policy.etaBufferMinutes), requiredBy: state.slaDeadlineAt ?? null });
  if (validCommitment && risk.level !== "CRITICAL") return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "VALID_OPERATOR_COMMITMENT", humanReason: "A credible operator commitment has not expired; re-evaluate after its buffer.", nextCheckAt: afterMinutes(state.operatorCommitment!.promisedAt, policy.commitmentBufferMinutes), requiredBy: state.slaDeadlineAt ?? null });
  if (decreased && risk.level === "LOW") return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "BACKLOG_IMPROVING", humanReason: "Backlog is materially decreasing with no elevated SLA risk.", nextCheckAt: afterMinutes(state.observedAt, policy.lowRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null });
  if (risk.level === "CRITICAL") return decision(state, policy, { decision: prior.length ? "ESCALATE" : "ACT_NOW", target: prior.length ? "MANAGER" : "TEAM_LEAD", reasonCode: prior.length ? "CRITICAL_RISK_AFTER_INTERVENTION" : "CRITICAL_RISK", humanReason: "Critical risk requires immediate governed attention; fatigue cannot suppress it.", nextCheckAt: afterMinutes(state.observedAt, policy.highRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? state.observedAt, recommendedActionType: prior.length ? "ESCALATION" : "FIRST_INTERVENTION", recommendedChannel: "EMPLOYEE_INBOX" });
  if (!prior.length && risk.level === "HIGH") return decision(state, policy, { decision: "ACT_NOW", target: "WAREHOUSE_OPERATOR", reasonCode: "HIGH_RISK_NO_PRIOR_INTERVENTION", humanReason: "High risk has no credible progress or prior intervention.", nextCheckAt: afterMinutes(state.observedAt, policy.highRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null, recommendedActionType: "FIRST_INTERVENTION", recommendedChannel: "EMPLOYEE_INBOX" });
  if (latest && hoursSince(latest.at, state.observedAt) * 60 < policy.recentInterventionMinutes && !hasMaterialStateChange(state)) return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "RECENT_INTERVENTION_NO_CHANGE", humanReason: "A recent confirmed intervention has no material new state; avoid an equivalent repeat.", nextCheckAt: afterMinutes(latest.at, policy.recentInterventionMinutes), requiredBy: state.slaDeadlineAt ?? null });
  if (prior.length >= policy.fatigueInterventionThreshold && fatigue === "HIGH" && !hasMaterialStateChange(state)) return decision(state, policy, { decision: "ESCALATE", target: "TEAM_LEAD", reasonCode: "REPEATED_UNPRODUCTIVE_INTERVENTIONS", humanReason: "Repeated confirmed interventions produced neither response nor progress; use a higher-authority path.", nextCheckAt: afterMinutes(state.observedAt, policy.highRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null, recommendedActionType: "ESCALATION", recommendedChannel: "EMPLOYEE_INBOX" });
  if (prior.length && risk.level === "HIGH") return decision(state, policy, { decision: "REQUEST_INFORMATION", target: "TEAM_LEAD", reasonCode: "HIGH_RISK_NEEDS_STATUS", humanReason: "Risk is elevated after a prior intervention without enough credible progress to repeat it mechanically.", nextCheckAt: afterMinutes(state.observedAt, policy.highRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null, recommendedActionType: "REQUEST_STATUS", recommendedChannel: "EMPLOYEE_INBOX" });
  return decision(state, policy, { decision: "WAIT", target: "NONE", reasonCode: "LOW_RISK_RECHECK", humanReason: "No intervention is currently justified; schedule a governed recheck.", nextCheckAt: afterMinutes(state.observedAt, policy.lowRiskCheckMinutes), requiredBy: state.slaDeadlineAt ?? null });
}

export function toEmployeeTask(item: AdaptiveInterventionDecision): EmployeeTask | null {
  if (!["ACT_NOW", "REQUEST_INFORMATION", "ESCALATE"].includes(item.decision)) return null;
  return { caseId: item.caseId, priority: item.riskLevel, title: item.decision === "ESCALATE" ? "Escalated operational case" : "Operational action required", decision: item.decision, instruction: item.humanReason, deadline: item.requiredBy, reasonSummary: item.reasonCode, allowedResponses: ["DONE", "CANNOT_COMPLETE", "IN_PROGRESS", "INFORMATION_INCORRECT"] };
}

export function managerCategory(item: AdaptiveInterventionDecision): ManagerCaseCategory {
  if (item.decision === "CLOSE") return "RESOLVED";
  if (item.decision === "ESCALATE") return "ESCALATION_REQUIRED";
  if (item.decision === "WAIT") return "WAITING_WITH_VALID_PLAN";
  if (item.decision === "REQUEST_INFORMATION" && item.confidence === "LOW") return "ANOMALOUS";
  if (item.riskLevel === "HIGH" || item.riskLevel === "CRITICAL") return "AT_RISK";
  return "NEEDS_ACTION_NOW";
}
