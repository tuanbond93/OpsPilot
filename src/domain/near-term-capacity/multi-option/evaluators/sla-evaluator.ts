import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionSla, RootCauseEvaluation } from "../types";

export function evaluateOptionSla(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  facts: CurrentRisk,
  lead: LeadFact | null,
  rootCause: RootCauseEvaluation
): DecisionOptionSla {
  switch (optionType) {
    case "NO_ACTION_MONITOR":
      if (rootCause.category === "NO_MATERIAL_CAPACITY_GAP") {
        return {
          projected_effect: "NEUTRAL",
          projected_clearance_at: null,
          breach_risk: "LOW",
          evidence_status: "GOVERNED",
          confidence: 0.85,
          evidence: [
            "Tồn kho nhỏ trong ngưỡng kiểm soát",
            "Lead xác nhận không có hàng về thêm đáng kể",
          ],
        };
      }
      // For large backlog (e.g. Case #003) or incoming surge:
      // Without handling throughput or vehicle schedules, clearance SLA cannot be proven.
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: rootCause.category === "INCOMING_VOLUME_RISK" ? "HIGH" : "MEDIUM",
        evidence_status: "UNKNOWN",
        confidence: 0.5,
        evidence: [
          "Chưa có tốc độ xử lý/giải tỏa đơn theo giờ tại trạm",
          "Chưa tích hợp hạn cam kết SLA chi tiết từng đơn hàng",
        ],
      };

    case "ADD_VEHICLE":
      return {
        projected_effect: "IMPROVE",
        projected_clearance_at: null,
        breach_risk: "LOW",
        evidence_status: "MODELED",
        confidence: 0.6,
        evidence: [
          "Bổ sung phương tiện giúp tăng khả năng xuất hàng kịp chuyến",
          "Thời gian hoàn thành cụ thể phụ thuộc vào giờ xe thực tế đến",
        ],
      };

    case "REQUEST_MORE_INFORMATION":
      return {
        projected_effect: "NEUTRAL",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.5,
        evidence: ["Cần thêm thông tin để đánh giá ảnh hưởng SLA"],
      };

    case "HOLD_LOW_PRIORITY_ECOM":
      return {
        projected_effect: "IMPROVE",
        projected_clearance_at: null,
        breach_risk: "LOW",
        evidence_status: "MODELED",
        confidence: 0.6,
        evidence: ["Ưu tiên nguồn lực giải tỏa đơn B2B và đơn rủi ro cao trước"],
      };

    default:
      return {
        projected_effect: "UNKNOWN",
        projected_clearance_at: null,
        breach_risk: "UNKNOWN",
        evidence_status: "UNKNOWN",
        confidence: 0.4,
        evidence: ["Thiếu dữ liệu mô hình hóa tác động SLA"],
      };
  }
}

export function formatSlaDisplay(sla: DecisionOptionSla): string {
  if (sla.projected_effect === "UNKNOWN") {
    return "UNKNOWN (Chưa đo lường được tiến độ SLA)";
  }
  if (sla.projected_effect === "NEUTRAL") {
    return "Ổn định (Rủi ro thấp theo ca hiện tại)";
  }
  if (sla.projected_effect === "IMPROVE") {
    return "Cải thiện (Hỗ trợ giải tỏa nhanh hơn)";
  }
  return "Nguy cơ chậm SLA";
}
