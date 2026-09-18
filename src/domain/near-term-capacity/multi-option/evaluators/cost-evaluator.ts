import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionCost } from "../types";

export function evaluateOptionCost(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  _facts: CurrentRisk,
  _lead: LeadFact | null
): DecisionOptionCost {
  switch (optionType) {
    case "NO_ACTION_MONITOR":
      // Zero incremental outlay is genuinely measured because no operational resources are dispatched.
      return {
        value_vnd: 0,
        evidence_status: "MEASURED",
        source: "ZERO_INCREMENTAL_EXPENDITURE",
      };

    case "REQUEST_MORE_INFORMATION":
      return {
        value_vnd: 0,
        evidence_status: "MEASURED",
        source: "COMMUNICATION_ZERO_EXPENDITURE",
      };

    case "ADD_VEHICLE":
    case "ADD_MANPOWER":
    case "REALLOCATE_AVAILABLE_CAPACITY":
    case "HOLD_LOW_PRIORITY_ECOM":
    case "HUMAN_INVESTIGATION_REQUIRED":
    default:
      // Operational fleet/manpower rates are unintegrated.
      // STRICT RULE: UNKNOWN != 0. Must remain null with status UNKNOWN.
      return {
        value_vnd: null,
        evidence_status: "UNKNOWN",
        source: null,
      };
  }
}

export function formatCostDisplay(cost: DecisionOptionCost): string {
  if (cost.evidence_status === "UNKNOWN" || cost.value_vnd === null) {
    return "UNKNOWN (Chưa có biểu phí định mức)";
  }
  if (cost.value_vnd === 0) {
    return "0 đ (Duy trì hiện trạng)";
  }
  return `${cost.value_vnd.toLocaleString("vi-VN")} đ`;
}
