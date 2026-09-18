import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionSla, RootCauseEvaluation } from "../types";

export function evaluateOptionSla(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  facts: CurrentRisk,
  _lead: LeadFact | null,
  _rootCause: RootCauseEvaluation
): DecisionOptionSla {
  // STRICT EVIDENCE BOUND:
  // SLA effect can ONLY be claimed if:
  // 1) Order-level SLA delivery deadlines exist, AND
  // 2) Station clearance throughput is quantitatively measured, AND
  // 3) Vehicle capacity/schedule is evidenced (for transport options).
  //
  // Currently, all three prerequisites are UNAVAILABLE in near-term capacity cases.
  // Therefore, claiming IMPROVE, NEUTRAL, or WORSEN is an unsupported projection.
  // SLA_EFFECT MUST REMAIN UNKNOWN.

  switch (optionType) {
    case "NO_ACTION_MONITOR":
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.2,
        evidence: [
          "Thiếu hạn cam kết SLA chi tiết từng đơn hàng",
          "Thiếu dữ liệu tốc độ/công suất phân loại giải tỏa đơn theo giờ tại trạm",
        ],
      };

    case "ADD_VEHICLE":
      // Missing vehicle capacity + missing dispatch schedule => CANNOT claim SLA IMPROVE
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.2,
        evidence: [
          "Chưa rõ tải trọng và giờ xe đến trạm nên chưa thể chứng minh mức độ cải thiện SLA",
          "Thiếu hạn SLA của các đơn đang dồn ứ để đo lường tỷ lệ cứu đơn",
        ],
      };

    case "REQUEST_MORE_INFORMATION":
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.2,
        evidence: [
          "Yêu cầu thêm dữ liệu về hạn SLA và năng suất trạm để đánh giá tác động",
        ],
      };

    default:
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.1,
        evidence: ["Thiếu dữ liệu đo lường SLA và năng lực xử lý"],
      };
  }
}

export function formatSlaDisplay(sla: DecisionOptionSla): string {
  if (sla.projected_effect === "UNKNOWN") {
    return "UNKNOWN (Chưa đo lường được hạn SLA & công suất giải tỏa)";
  }
  if (sla.projected_effect === "IMPROVE") {
    return "Cải thiện (Đã chứng minh bằng dữ liệu xe & hạn đơn)";
  }
  if (sla.projected_effect === "NEUTRAL") {
    return "Ổn định (Đã chứng minh giải tỏa kịp hạn SLA)";
  }
  return "Nguy cơ chậm SLA";
}
