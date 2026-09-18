import type { DecisionOption, MultiOptionDecisionResult } from "./types";

export function critiqueMultiOptionRecommendation(
  result: Pick<
    MultiOptionDecisionResult,
    "recommended_option" | "recommendation_reason" | "tradeoff_summary"
  >,
  candidates: DecisionOption[]
): { verdict: "VALID" | "INVALID"; flags: string[] } {
  const flags: string[] = [];

  // Special safe state: INSUFFICIENT_EVIDENCE is always allowed when data is missing
  if (result.recommended_option === "INSUFFICIENT_EVIDENCE") {
    return { verdict: "VALID", flags: [] };
  }

  // 1. Must be in candidate options
  const chosen = candidates.find((c) => c.option_type === result.recommended_option);
  if (!chosen) {
    flags.push("SELECTED_OPTION_NOT_IN_CANDIDATES");
    return { verdict: "INVALID", flags };
  }

  // 2. Must be feasible
  if (!chosen.feasible) {
    flags.push(`SELECTED_OPTION_INFEASIBLE: ${chosen.infeasible_reason || "Not feasible"}`);
  }

  // 3. UNKNOWN cost must never be treated as zero
  const fullText = `${result.recommendation_reason} ${result.tradeoff_summary}`;
  if (chosen.cost.evidence_status === "UNKNOWN") {
    if (
      /chi phí\s*(bằng\s*)?0/i.test(fullText) ||
      /không tốn chi phí/i.test(fullText) ||
      /chi phí\s*:\s*0/i.test(fullText) ||
      /0\s*(vnđ|đ|vnd)/i.test(fullText)
    ) {
      flags.push("UNKNOWN_COST_TREATED_AS_ZERO");
    }
  }

  // 4. Cost stated as specific fact without governed evidence
  if (
    chosen.cost.evidence_status === "UNKNOWN" &&
    /\b\d{1,3}(?:[.,]\d{3})+\s*(?:vnđ|đ|vnd)/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_COST_CLAIM");
  }

  // 5. Unsupported SLA projection (e.g. fabricated clearance hours or probabilities)
  if (
    chosen.sla.evidence_status === "UNKNOWN" &&
    /cam kết giải tỏa lúc \d{1,2}:\d{2}/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_SLA_PROJECTION");
  }

  // 6. Unsupported capacity projection
  if (
    chosen.capacity.status === "UNKNOWN" &&
    /\+\s*\d+(?:\.\d+)?\s*(?:kg|tấn|m3)/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_CAPACITY_PROJECTION");
  }

  return {
    verdict: flags.length === 0 ? "VALID" : "INVALID",
    flags,
  };
}
