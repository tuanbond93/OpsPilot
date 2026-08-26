import type { PostWindowOutcomeEvidence } from "./outcome-evidence";

export interface DecisionFollowupShadowInput {
  scheduleId: string;
  checkAt: string;
  now: string;
  decisionStatus: string;
  decisionMode: string;
  evidence: PostWindowOutcomeEvidence | null;
}

export type DecisionFollowupShadowPlan =
  | { kind: "SKIP"; reason: string }
  | { kind: "OBSERVE"; observationState: "READY_TO_VERIFY" | "AWAITING_POST_WINDOW_EVIDENCE"; idempotencyKey: string; evidence: PostWindowOutcomeEvidence | null };

export function buildDecisionFollowupShadowPlan(input: DecisionFollowupShadowInput): DecisionFollowupShadowPlan {
  if (input.decisionMode !== "HUMAN_APPROVAL") return { kind: "SKIP", reason: "NON_HUMAN_APPROVAL_DECISION" };
  if (input.decisionStatus !== "EXECUTED") return { kind: "SKIP", reason: "DECISION_NOT_EXECUTED" };
  if (Date.parse(input.now) < Date.parse(input.checkAt)) return { kind: "SKIP", reason: "FOLLOWUP_NOT_DUE" };
  const observationState = input.evidence ? "READY_TO_VERIFY" : "AWAITING_POST_WINDOW_EVIDENCE";
  const fingerprint = input.evidence ? `${input.evidence.kind}:${input.evidence.observedAt}` : observationState;
  return { kind: "OBSERVE", observationState, idempotencyKey: `lc10-shadow:${input.scheduleId}:${fingerprint}`, evidence: input.evidence };
}
