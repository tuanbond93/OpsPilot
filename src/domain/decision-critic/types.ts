import type { FinalDecisionResult } from "@/domain/final-decision";

export type DecisionCriticVerdict = "PASS" | "HUMAN_INVESTIGATION_REQUIRED";

export type DecisionCriticReasonCode =
  | "UPSTREAM_ABSTAINED"
  | "SELECTED_OPTION_MISSING"
  | "ACTION_MISSING"
  | "RATIONALE_MISSING"
  | "EVIDENCE_MISSING"
  | "CONFIDENCE_BELOW_THRESHOLD"
  | "HIGH_RISK_PREREQUISITE_UNRESOLVED";

export interface DecisionCriticInput {
  finalDecision: FinalDecisionResult;
  reviewedAt?: string;
}

export interface DecisionCriticResult {
  verdict: DecisionCriticVerdict;
  reasonCodes: DecisionCriticReasonCode[];
  reviewSummary: string;
  checks: {
    selectedOptionPresent: boolean;
    actionPresent: boolean;
    rationalePresent: boolean;
    evidencePresent: boolean;
    confidenceThreshold: number;
    confidenceSufficient: boolean;
    highRiskPrerequisitesResolved: boolean;
  };
  humanInvestigation: {
    action: string;
    rationale: string;
    requiredData: string[];
  } | null;
  provenance: {
    critic: "DETERMINISTIC_DECISION_CRITIC";
    version: "lc02-v1";
    reviewedDecisionVersion: "lc01-v1";
    reviewedAt: string;
  };
}
