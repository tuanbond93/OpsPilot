import type { Decision, DecisionMemoryMatch, DecisionMemoryResult, VerifiedDecisionMemoryRecord } from "./types";

function comparableValue(decision: Decision, section: "signalContext" | "actionContext", key: string): string | undefined {
  const value = decision.evidence[section] as Record<string, unknown> | undefined;
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

export function retrieveComparableDecisions(target: Decision, records: readonly VerifiedDecisionMemoryRecord[], limit = 10): DecisionMemoryResult {
  const matches = records.flatMap(({ decision, verification }): DecisionMemoryMatch[] => {
    if (decision.decisionId === target.decisionId) return [];
    const factors: string[] = [];
    let score = 0;
    if (decision.sourceLinks.sourceType === target.sourceLinks.sourceType) { score += 2; factors.push("same_source_type"); }
    if (decision.riskLevel === target.riskLevel) { score += 1; factors.push("same_risk_level"); }
    const targetReason = comparableValue(target, "signalContext", "reasonCode");
    if (targetReason && targetReason === comparableValue(decision, "signalContext", "reasonCode")) { score += 3; factors.push("same_reason_code"); }
    const targetAction = comparableValue(target, "actionContext", "candidateType");
    if (targetAction && targetAction === comparableValue(decision, "actionContext", "candidateType")) { score += 2; factors.push("same_candidate_type"); }
    if (!score) return [];
    return [{ decisionId: decision.decisionId, outcome: verification.classification, reasonCode: verification.reasonCode,
      similarityScore: score, matchingFactors: factors, observedAt: verification.observedAt, source: verification.source }];
  });
  return {
    targetDecisionId: target.decisionId,
    matches: matches.sort((a, b) => b.similarityScore - a.similarityScore || b.observedAt.localeCompare(a.observedAt)).slice(0, Math.min(Math.max(limit, 1), 25)),
    nonCausalNotice: "Comparable verified outcomes are retrieval evidence only; they do not establish causation or override current decision evidence.",
  };
}
