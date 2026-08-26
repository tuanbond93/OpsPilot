import type { PlannerRecommendation } from "@/agents/action-planner/schema";
import type { FinalDecisionCandidate, FinalDecisionInput, FinalDecisionResult } from "./types";

const PRIORITY_SCORE = { high: 30, medium: 20, low: 10 } as const;
const RISK_SCORE = { critical: 30, high: 22, medium: 14, low: 6 } as const;

function boundedConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

function candidateFrom(recommendation: PlannerRecommendation): FinalDecisionCandidate {
  const priority = PRIORITY_SCORE[recommendation.priority] ? recommendation.priority : "low";
  const riskSeverity = RISK_SCORE[recommendation.riskImpact?.severity] ? recommendation.riskImpact.severity : "low";
  const evidenceRefs = [...new Set((recommendation.evidenceCodes || []).filter(Boolean))].sort();
  const prerequisiteData = [...new Set((recommendation.prerequisiteData || []).filter(Boolean))].sort();
  const score = PRIORITY_SCORE[priority]
    + RISK_SCORE[riskSeverity]
    + Math.min(evidenceRefs.length, 5) * 4
    - Math.min(prerequisiteData.length, 5) * 5;
  return {
    optionId: recommendation.id || recommendation.type || "UNIDENTIFIED_OPTION",
    action: recommendation.description || recommendation.title,
    rationale: recommendation.rationale,
    priority,
    riskSeverity,
    evidenceRefs,
    prerequisiteData,
    targetRole: recommendation.targetRole || "OPERATIONS_LEAD",
    score,
  };
}

function compareCandidates(left: FinalDecisionCandidate, right: FinalDecisionCandidate): number {
  return right.score - left.score || left.optionId.localeCompare(right.optionId);
}

export function makeFinalDecision(input: FinalDecisionInput): FinalDecisionResult {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const provenance = {
    engine: "DETERMINISTIC_FINAL_DECISION" as const,
    version: "lc01-v1" as const,
    incidentId: input.incidentId,
    plannerRunId: input.plannerRunId,
    generatedAt,
  };
  const alternatives = input.recommendations.map(candidateFrom).sort(compareCandidates);
  const selectedOption = alternatives[0] || null;
  const investigation = input.investigations[0];

  if (!selectedOption) {
    return {
      disposition: "HUMAN_INVESTIGATION_REQUIRED",
      selectedOption: null,
      alternatives: [],
      selectionRationale: "Planner did not produce an actionable, governed candidate option.",
      expectedOperationalOutcome: "Collect the missing operational evidence required for a safe decision.",
      risksAndLimitations: [...new Set(["No actionable candidate option is available.", ...input.limitations])],
      confidence: boundedConfidence(input.plannerConfidence),
      evidenceRefs: [],
      humanInvestigation: investigation ? {
        action: investigation.action,
        rationale: investigation.rationale,
        requiredData: [...new Set(investigation.requiredData.filter(Boolean))].sort(),
      } : {
        action: "Review incident evidence with the responsible operations lead.",
        rationale: "A human must establish an actionable option before approval.",
        requiredData: [],
      },
      provenance,
    };
  }

  return {
    disposition: "DECIDE",
    selectedOption,
    alternatives: alternatives.slice(1),
    selectionRationale: `Selected ${selectedOption.optionId} using LC-01 deterministic ranking (score ${selectedOption.score}); ties are resolved by stable option id. ${selectedOption.rationale}`,
    expectedOperationalOutcome: `The responsible role ${selectedOption.targetRole} completes the approved operational action and the incident can be reassessed against a later evidence snapshot.`,
    risksAndLimitations: [...new Set([
      `Potential consequence if not addressed: ${input.recommendations.find((item) => item.id === selectedOption.optionId)?.riskImpact.potentialConsequence || "not specified"}.`,
      ...selectedOption.prerequisiteData.map((item) => `Prerequisite data: ${item}.`),
      ...input.limitations,
    ])],
    confidence: boundedConfidence(input.plannerConfidence),
    evidenceRefs: selectedOption.evidenceRefs,
    humanInvestigation: null,
    provenance,
  };
}
