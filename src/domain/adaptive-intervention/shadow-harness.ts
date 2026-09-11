import { decideAdaptiveIntervention } from "./engine";
import type { AdaptiveInterventionState, AdaptiveShadowComparison, ShadowComparisonClass } from "./types";

const classify = (v1: AdaptiveInterventionState["v1Decision"], v2: ReturnType<typeof decideAdaptiveIntervention>): ShadowComparisonClass => {
  if (!v1) return "UNKNOWN";
  if ((v1 === "RESOLVED" || v1 === "CLOSED") && v2.decision === "CLOSE") return "SAME_ACTION";
  if (v1 === "SECOND_PUSH" && v2.decision === "WAIT") return "V2_AVOIDS_UNNECESSARY_NOTIFICATION";
  if (v1 === "SECOND_PUSH" && v2.decision === "ESCALATE") return "V2_ESCALATES_INSTEAD_OF_REPEAT";
  if (v1 === "NONE" && v2.decision === "ACT_NOW") return "V2_INTERVENES_EARLIER";
  if (v2.decision === "REQUEST_INFORMATION") return "V2_REQUESTS_INFORMATION";
  if (["FIRST_PUSH", "SECOND_PUSH", "THIRD_PUSH", "ESCALATION"].includes(v1) && v2.decision === "CLOSE") return "V2_POTENTIAL_MISS";
  return "UNKNOWN";
};

export interface AdaptiveShadowSummary {
  totalCases: number;
  ACT_NOW: number; WAIT: number; REQUEST_INFORMATION: number; ESCALATE: number; CLOSE: number;
  V1_SAME: number; V2_AVOIDS_NOTIFICATION: number; V2_ESCALATES_INSTEAD_OF_REPEAT: number; V2_INTERVENES_EARLIER: number; V2_POTENTIAL_MISS: number; UNKNOWN: number;
}

/** Local fixture/read-snapshot evaluator. It never calls a database or dispatcher. */
export function evaluateAdaptiveShadow(states: AdaptiveInterventionState[]): { comparisons: AdaptiveShadowComparison[]; summary: AdaptiveShadowSummary } {
  const comparisons = states.map(state => {
    const v2Decision = decideAdaptiveIntervention(state);
    return { caseId: state.caseId, v1Decision: state.v1Decision ?? "NONE", v2Decision, classification: classify(state.v1Decision, v2Decision) };
  });
  const countDecision = (name: keyof Pick<AdaptiveShadowSummary, "ACT_NOW" | "WAIT" | "REQUEST_INFORMATION" | "ESCALATE" | "CLOSE">) => comparisons.filter(item => item.v2Decision.decision === name).length;
  const countClass = (name: ShadowComparisonClass) => comparisons.filter(item => item.classification === name).length;
  return { comparisons, summary: { totalCases: comparisons.length, ACT_NOW: countDecision("ACT_NOW"), WAIT: countDecision("WAIT"), REQUEST_INFORMATION: countDecision("REQUEST_INFORMATION"), ESCALATE: countDecision("ESCALATE"), CLOSE: countDecision("CLOSE"), V1_SAME: countClass("SAME_ACTION"), V2_AVOIDS_NOTIFICATION: countClass("V2_AVOIDS_UNNECESSARY_NOTIFICATION"), V2_ESCALATES_INSTEAD_OF_REPEAT: countClass("V2_ESCALATES_INSTEAD_OF_REPEAT"), V2_INTERVENES_EARLIER: countClass("V2_INTERVENES_EARLIER"), V2_POTENTIAL_MISS: countClass("V2_POTENTIAL_MISS"), UNKNOWN: countClass("UNKNOWN") } };
}
