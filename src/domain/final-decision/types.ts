import type { PlannerInvestigation, PlannerRecommendation } from "@/agents/action-planner/schema";

export type FinalDecisionDisposition = "DECIDE" | "HUMAN_INVESTIGATION_REQUIRED";

export interface FinalDecisionCandidate {
  optionId: string;
  action: string;
  rationale: string;
  priority: "high" | "medium" | "low";
  riskSeverity: "critical" | "high" | "medium" | "low";
  evidenceRefs: string[];
  prerequisiteData: string[];
  targetRole: string;
  score: number;
}

export interface FinalDecisionInput {
  incidentId: string;
  plannerRunId: string;
  plannerConfidence: number;
  recommendations: PlannerRecommendation[];
  investigations: PlannerInvestigation[];
  limitations: string[];
  generatedAt?: string;
}

export interface FinalDecisionResult {
  disposition: FinalDecisionDisposition;
  selectedOption: FinalDecisionCandidate | null;
  alternatives: FinalDecisionCandidate[];
  selectionRationale: string;
  expectedOperationalOutcome: string;
  risksAndLimitations: string[];
  confidence: number;
  evidenceRefs: string[];
  humanInvestigation: {
    action: string;
    rationale: string;
    requiredData: string[];
  } | null;
  provenance: {
    engine: "DETERMINISTIC_FINAL_DECISION";
    version: "lc01-v1";
    incidentId: string;
    plannerRunId: string;
    generatedAt: string;
  };
}
