import { DecisionDomainError } from "./state-machine";
import type { DecisionOutcomeObservationContract, DecisionOutcomeVerification, VerifyDecisionOutcomeInput } from "./types";

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function verifyOutcomeObservation(contract: DecisionOutcomeObservationContract, input: VerifyDecisionOutcomeInput): Omit<DecisionOutcomeVerification, "verificationId" | "createdAt"> {
  if (new Date(input.observedAt).getTime() < new Date(contract.measurementWindowEnd).getTime()) {
    throw new DecisionDomainError("OUTCOME_MEASUREMENT_WINDOW_NOT_REACHED", "Outcome evidence must be captured at or after the scheduled follow-up window.");
  }
  if (!input.evidenceRefs.length) throw new DecisionDomainError("OUTCOME_EVIDENCE_REQUIRED", "Outcome verification requires post-execution evidence references.");
  const baseline = numeric(contract.baselineSnapshot.operationalFacts.affectedOrders);
  const observed = numeric(input.observedMetrics.affectedOrders);
  let classification: DecisionOutcomeVerification["classification"] = "INCONCLUSIVE";
  let reasonCode: DecisionOutcomeVerification["reasonCode"] = "INCONCLUSIVE_METRIC_UNAVAILABLE";
  if (baseline !== null && observed !== null) {
    if (observed === 0) { classification = "SUCCESS"; reasonCode = "SUCCESS_RESOLVED"; }
    else if (observed >= baseline) { classification = "FAILURE"; reasonCode = "FAILURE_NO_IMPROVEMENT"; }
    else { reasonCode = "INCONCLUSIVE_PARTIAL_IMPROVEMENT"; }
  }
  return {
    decisionId: input.decisionId, contractId: contract.contractId, classification, reasonCode,
    baselineAffectedOrders: baseline, observedAffectedOrders: observed, observedMetrics: input.observedMetrics,
    observedAt: input.observedAt, source: input.source, evidenceRefs: input.evidenceRefs,
    verifiedBy: input.actor,
  };
}
