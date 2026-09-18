import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionCapacity } from "../types";

export function evaluateOptionCapacity(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  facts: CurrentRisk,
  _lead: LeadFact | null
): DecisionOptionCapacity {
  const backlogDesc =
    facts.currentKg != null
      ? `${facts.currentKg} kg (${facts.currentOrders ?? "?"} đơn)`
      : `${facts.currentOrders ?? "?"} đơn (thiếu kg)`;

  switch (optionType) {
    case "NO_ACTION_MONITOR":
      return {
        current_capacity_kg: null,
        current_capacity_orders: null,
        added_kg: 0,
        added_orders: 0,
        added_vehicle_days: 0,
        resulting_capacity_kg: null,
        capacity_gap_before: backlogDesc,
        capacity_gap_after: "Giữ nguyên năng lực hiện có",
        status: "MEASURED",
      };

    case "REQUEST_MORE_INFORMATION":
      return {
        current_capacity_kg: null,
        current_capacity_orders: null,
        added_kg: 0,
        added_orders: 0,
        added_vehicle_days: 0,
        resulting_capacity_kg: null,
        capacity_gap_before: backlogDesc,
        capacity_gap_after: "Chưa thay đổi (chờ bổ sung thông tin)",
        status: "MEASURED",
      };

    case "ADD_VEHICLE":
      // Since vehicle class and fleet availability are not integrated,
      // added capacity must remain UNKNOWN.
      return {
        current_capacity_kg: null,
        current_capacity_orders: null,
        added_kg: null,
        added_orders: null,
        added_vehicle_days: null,
        resulting_capacity_kg: null,
        capacity_gap_before: backlogDesc,
        capacity_gap_after: "UNKNOWN (Chưa xác định tải trọng xe khả dụng)",
        status: "UNKNOWN",
      };

    case "REALLOCATE_AVAILABLE_CAPACITY":
    case "ADD_MANPOWER":
    case "HOLD_LOW_PRIORITY_ECOM":
    case "HUMAN_INVESTIGATION_REQUIRED":
    default:
      return {
        current_capacity_kg: null,
        current_capacity_orders: null,
        added_kg: null,
        added_orders: null,
        added_vehicle_days: null,
        resulting_capacity_kg: null,
        capacity_gap_before: backlogDesc,
        capacity_gap_after: "UNKNOWN (Chưa có dữ liệu năng lực)",
        status: "UNKNOWN",
      };
  }
}

export function formatCapacityDisplay(capacity: DecisionOptionCapacity): string {
  if (capacity.status === "UNKNOWN" || capacity.added_kg === null) {
    return "UNKNOWN (Chưa rõ tải trọng bổ sung)";
  }
  if (capacity.added_kg === 0) {
    return "+0 kg (Không tăng tải xe)";
  }
  return `+${capacity.added_kg} kg`;
}
