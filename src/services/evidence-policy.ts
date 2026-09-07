export type EvidenceTier = "RILLNET_OBSERVED" | "GHN_VERIFIED" | "HUMAN_VERIFICATION_REQUIRED";
export type GhnVerificationReason = "SOURCE_CONFLICT" | "STALE_EVIDENCE" | "ESCALATION" | "MANAGER_DECISION" | "OUTCOME_VERIFICATION" | "EXPLICIT_BUSINESS_RULE";

export type GhnVerificationDecision = { required: boolean; reason?: GhnVerificationReason };

/** Small, explicit boundary: the existence of a follow-up case is not a reason to call GHN. */
export function needsGhnVerification(context: {
  sourceConflict?: boolean;
  staleBeyondGovernedThreshold?: boolean;
  escalation?: boolean;
  managerDecision?: boolean;
  outcomeVerification?: boolean;
  explicitBusinessRule?: boolean;
}): GhnVerificationDecision {
  if (context.sourceConflict) return { required: true, reason: "SOURCE_CONFLICT" };
  if (context.staleBeyondGovernedThreshold) return { required: true, reason: "STALE_EVIDENCE" };
  if (context.escalation) return { required: true, reason: "ESCALATION" };
  if (context.managerDecision) return { required: true, reason: "MANAGER_DECISION" };
  if (context.outcomeVerification) return { required: true, reason: "OUTCOME_VERIFICATION" };
  if (context.explicitBusinessRule) return { required: true, reason: "EXPLICIT_BUSINESS_RULE" };
  return { required: false };
}
