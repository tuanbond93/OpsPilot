import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionCost } from "../types";

export function evaluateOptionCost(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  _facts: CurrentRisk,
  _lead: LeadFact | null
): DecisionOptionCost {
  switch (optionType) {
    case "NO_ACTION_MONITOR":
      // Zero incremental intervention outlay is measured because no additional external resource is dispatched.
      // NOTE: This does NOT imply total station operating cost is 0.
      return {
        incremental_cost_vnd: 0,
        value_vnd: 0,
        evidence_status: "MEASURED",
        source: "ZERO_INCREMENTAL_INTERVENTION_EXPENDITURE",
        notes: "Chi phí can thiệp phát sinh = 0 đ (không bao gồm chi phí vận hành trạm tiêu chuẩn).",
      };

    case "REQUEST_MORE_INFORMATION":
      return {
        incremental_cost_vnd: 0,
        value_vnd: 0,
        evidence_status: "MEASURED",
        source: "COMMUNICATION_ZERO_INCREMENTAL_EXPENDITURE",
        notes: "Yêu cầu thông tin qua hệ thống không phát sinh chi phí vận hành tăng thêm.",
      };

    case "ADD_VEHICLE":
    case "ADD_MANPOWER":
    case "REALLOCATE_AVAILABLE_CAPACITY":
    case "HOLD_LOW_PRIORITY_ECOM":
    case "HUMAN_INVESTIGATION_REQUIRED":
    default:
      // STRICT RULE: UNKNOWN != 0. Must remain null with status UNKNOWN.
      return {
        incremental_cost_vnd: null,
        value_vnd: null,
        evidence_status: "UNKNOWN",
        source: null,
        notes: "Chưa có biểu phí định mức hoặc thỏa thuận giá khả dụng.",
      };
  }
}

export function formatCostDisplay(cost: DecisionOptionCost): string {
  if (cost.evidence_status === "UNKNOWN" || cost.incremental_cost_vnd === null) {
    return "UNKNOWN (Chưa có biểu phí định mức)";
  }
  if (cost.incremental_cost_vnd === 0) {
    return "0 đ (Chi phí can thiệp phát sinh)";
  }
  return `${cost.incremental_cost_vnd.toLocaleString("vi-VN")} đ`;
}
