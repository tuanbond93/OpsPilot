import type { DecisionOption, MultiOptionDecisionResult, RootCauseEvaluation } from "./types";

export interface CritiqueInput {
  recommended_option: MultiOptionDecisionResult["recommended_option"];
  recommendation_reason: string;
  tradeoff_summary: string;
  root_cause?: RootCauseEvaluation;
}

export function critiqueMultiOptionRecommendation(
  result: CritiqueInput,
  candidates: DecisionOption[]
): { verdict: "VALID" | "INVALID"; flags: string[] } {
  const flags: string[] = [];
  const fullText = `${result.recommendation_reason} ${result.tradeoff_summary}`;

  // 1. Root-cause labels referencing unavailable evidence (e.g. SLA_AGING_RISK without SLA deadline data)
  if (
    result.root_cause?.category === ("SLA_AGING_RISK" as any) ||
    result.root_cause?.category === ("SLA_BREACH_RISK" as any) ||
    /\bSLA_AGING_RISK\b/i.test(fullText) ||
    /\bSLA_BREACH_RISK\b/i.test(fullText)
  ) {
    flags.push("ROOT_CAUSE_EXCEEDS_EVIDENCE: SLA risk cannot be claimed without order-level SLA delivery deadlines");
  }

  // 2. Unsupported high-confidence causal claims when critical capability telemetry is absent
  if (result.root_cause) {
    if (
      result.root_cause.category === "NO_MATERIAL_GAP" &&
      result.root_cause.confidence > 0.6
    ) {
      flags.push(
        "UNSUPPORTED_HIGH_CONFIDENCE_CAUSAL_CLAIM: NO_MATERIAL_GAP confidence cannot exceed 0.6 without a governed station capacity threshold"
      );
    }
    if (
      result.root_cause.confidence > 0.5 &&
      (result.root_cause.category === "CAPACITY_CAUSE_UNKNOWN" ||
        result.root_cause.category === "TRANSPORT_CAPACITY_SHORTAGE" ||
        result.root_cause.category === "MANPOWER_SHORTAGE" ||
        result.root_cause.category === "UNKNOWN")
    ) {
      flags.push(
        "UNSUPPORTED_HIGH_CONFIDENCE_CAUSAL_CLAIM: Confidence cannot exceed 0.5 when critical fleet/throughput telemetry is missing"
      );
    }
  }

  // 3. Missing evidence cannot justify INFEASIBLE (must be UNKNOWN)
  for (const cand of candidates) {
    if (cand.feasibility_status === "INFEASIBLE") {
      const reason = (cand.feasibility_reason || cand.infeasible_reason || "").toLowerCase();
      const isMissingEvidence =
        reason.includes("chưa có") ||
        reason.includes("thiếu dữ liệu") ||
        reason.includes("chưa tích hợp") ||
        reason.includes("chưa kết nối") ||
        reason.includes("no_governed") ||
        reason.includes("missing");
      const hasPositiveConstraint =
        reason.includes("cấm") ||
        reason.includes("prohibit") ||
        reason.includes("bị chặn") ||
        reason.includes("hết hạn") ||
        reason.includes("zero available");

      if (isMissingEvidence && !hasPositiveConstraint) {
        flags.push(
          `MISSING_EVIDENCE_CANNOT_JUSTIFY_INFEASIBLE: Option ${cand.option_type} marked INFEASIBLE due to missing evidence instead of UNKNOWN`
        );
      }
    }
  }

  // 4. Economically unnecessary being represented as infeasible across candidates
  for (const cand of candidates) {
    if (
      cand.feasibility_status === "INFEASIBLE" &&
      (cand.feasibility_reason?.includes("ECONOMICALLY_UNNECESSARY") ||
        cand.infeasible_reason?.includes("ECONOMICALLY_UNNECESSARY"))
    ) {
      flags.push(
        `ECONOMIC_JUSTIFICATION_CONFUSED_WITH_FEASIBILITY: Option ${cand.option_type} marked INFEASIBLE due to economic lack of necessity`
      );
    }
  }

  // 5. Economic JUSTIFIED / NOT_JUSTIFIED requires economic evidence / rule
  for (const cand of candidates) {
    // REQUEST_MORE_INFORMATION is permitted to be JUSTIFIED as an info-gathering action with 0 incremental outlay
    if (cand.option_type !== "REQUEST_MORE_INFORMATION") {
      if (cand.economic.status === "JUSTIFIED" || cand.economic.status === "NOT_JUSTIFIED") {
        if (cand.cost.evidence_status === "UNKNOWN" || cand.cost.incremental_cost_vnd === null) {
          flags.push(
            `UNSUPPORTED_ECONOMIC_STATUS: Option ${cand.option_type} claims ${cand.economic.status} without governed economic evidence or rate matrix`
          );
        }
      }
    }
  }

  // Safe conservative outcome: INSUFFICIENT_EVIDENCE
  if (result.recommended_option === "INSUFFICIENT_EVIDENCE") {
    return {
      verdict: flags.length === 0 ? "VALID" : "INVALID",
      flags,
    };
  }

  // 4. Must be in candidate options
  const chosen = candidates.find((c) => c.option_type === result.recommended_option);
  if (!chosen) {
    flags.push("SELECTED_OPTION_NOT_IN_CANDIDATES");
    return { verdict: "INVALID", flags };
  }

  // 6. Must be feasible (not INFEASIBLE or UNKNOWN)
  if (chosen.feasibility_status === "INFEASIBLE") {
    flags.push(`SELECTED_OPTION_INFEASIBLE: ${chosen.feasibility_reason || chosen.infeasible_reason || "Not feasible"}`);
  }
  if (chosen.feasibility_status === "UNKNOWN") {
    flags.push(`SELECTED_OPTION_FEASIBILITY_UNKNOWN: Cannot recommend ${chosen.option_type} when operational feasibility is UNKNOWN`);
  }

  // 6. FEASIBLE claimed when critical execution prerequisites are UNKNOWN
  if (chosen.feasibility_status === "FEASIBLE") {
    if (
      chosen.option_type === "ADD_VEHICLE" &&
      chosen.unknowns.some((u) => u.toLowerCase().includes("xe") || u.toLowerCase().includes("biểu phí"))
    ) {
      flags.push(
        "UNSUPPORTED_FEASIBILITY_CLAIM: ADD_VEHICLE marked FEASIBLE when vehicle availability/rate is unknown"
      );
    }
  }

  // 7. SLA directional claims without evidence
  // 7a. SLA IMPROVE claimed without SLA deadlines and station throughput
  if (
    chosen.sla.projected_effect === "IMPROVE" ||
    /cải thiện\s+SLA/i.test(fullText) ||
    /cứu\s+đơn\s+SLA/i.test(fullText)
  ) {
    if (chosen.sla.evidence_status === "UNKNOWN") {
      flags.push(
        "UNSUPPORTED_SLA_IMPROVE_CLAIM: Cannot claim SLA improvement without order SLA deadlines and throughput"
      );
    }
  }

  // 7b. SLA NEUTRAL claimed without evidence
  if (
    chosen.sla.projected_effect === "NEUTRAL" ||
    /ổn định\s+SLA/i.test(fullText) ||
    /đảm bảo\s+SLA/i.test(fullText)
  ) {
    if (chosen.sla.evidence_status === "UNKNOWN") {
      flags.push(
        "UNSUPPORTED_SLA_NEUTRAL_CLAIM: Cannot claim SLA neutrality/stability without order SLA deadlines"
      );
    }
  }

  // 8. Total cost zero when only incremental intervention cost is zero
  if (
    /tổng chi phí(\s+vận hành)?(\s+bằng|\s+là)?\s*0/i.test(fullText) ||
    /không tốn chi phí vận hành(\s+trạm)?/i.test(fullText)
  ) {
    flags.push(
      "INCREMENTAL_COST_CONFUSED_WITH_TOTAL_OPERATING_COST: Zero incremental outlay must not be stated as zero total station operating cost"
    );
  }

  // 9. UNKNOWN cost must never be treated as zero
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

  // 10. Cost difference cannot be claimed as realized saving or ROI
  if (
    /\b(tiết kiệm|realized saving|roi|realized_saving)\b/i.test(fullText) &&
    !/chưa chứng minh được tiết kiệm|không khẳng định tiết kiệm|chưa thể coi là tiết kiệm/i.test(fullText)
  ) {
    flags.push(
      "UNSUPPORTED_SAVING_CLAIM: Projected incremental cost difference cannot be claimed as realized saving or ROI"
    );
  }

  // 10. Cost stated as specific fact without governed evidence
  if (
    chosen.cost.evidence_status === "UNKNOWN" &&
    /\b\d{1,3}(?:[.,]\d{3})+\s*(?:vnđ|đ|vnd)/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_COST_CLAIM");
  }

  // 11. Unsupported SLA projection (e.g. fabricated clearance hours or dates)
  if (
    chosen.sla.evidence_status === "UNKNOWN" &&
    /cam kết giải tỏa lúc \d{1,2}:\d{2}/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_SLA_PROJECTION");
  }

  // 12. Unsupported capacity projection
  if (
    chosen.capacity.status === "UNKNOWN" &&
    /\+\s*\d+(?:\.\d+)?\s*(?:kg|tấn|m3)/i.test(fullText)
  ) {
    flags.push("UNSUPPORTED_CAPACITY_PROJECTION");
  }

  // 13. Rejection of NO_ACTION_MONITOR selected solely because intervention evidence is missing
  if (result.recommended_option === "NO_ACTION_MONITOR") {
    const isMaterialRisk =
      result.root_cause &&
      result.root_cause.category !== "NO_MATERIAL_GAP" &&
      result.root_cause.category !== "NO_MATERIAL_CAPACITY_GAP";

    const interventionWithMissingEvidence = candidates.find(
      (c) =>
        c.option_type !== "NO_ACTION_MONITOR" &&
        c.option_type !== "REQUEST_MORE_INFORMATION" &&
        (c.cost.evidence_status === "UNKNOWN" || c.capacity.status === "UNKNOWN")
    );

    if (isMaterialRisk && interventionWithMissingEvidence) {
      flags.push(
        "DEFAULT_TO_NO_ACTION_ON_MISSING_EVIDENCE: Failure to prove intervention option due to missing evidence does not prove NO_ACTION_MONITOR is preferable. Must return REQUEST_MORE_INFORMATION or INSUFFICIENT_EVIDENCE."
      );
    }

    if (
      /(chưa có|thiếu)\s+(dữ liệu|biểu phí|thông tin|năng lực|khả năng|bằng chứng).*nên\s+(chọn|duy trì|khuyến nghị|ưu tiên)\s+(no_action|theo dõi|hiện trạng)/i.test(fullText) ||
      /do (chưa có|thiếu)\s+(dữ liệu|biểu phí|thông tin).*chọn.*(no_action|theo dõi|hiện trạng)/i.test(fullText)
    ) {
      flags.push(
        "DEFAULT_TO_NO_ACTION_ON_MISSING_EVIDENCE: Recommendation text indicates NO_ACTION_MONITOR was selected solely because intervention data is missing."
      );
    }
  }

  return {
    verdict: flags.length === 0 ? "VALID" : "INVALID",
    flags,
  };
}
