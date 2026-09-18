import type { CapacityAction, CurrentRisk, LeadFact } from "../../loop";
import type { DecisionOptionCapacity } from "../types";
import type { VehicleCapacityEvidence } from "../sources/vehicle-source-adapter";

export function evaluateOptionCapacity(
  optionType: CapacityAction | "REQUEST_MORE_INFORMATION",
  facts: CurrentRisk,
  _lead: LeadFact | null,
  capacityEvidence?: VehicleCapacityEvidence | null
): DecisionOptionCapacity {
  // STRICT RULE:
  // CAPACITY_GAP_BEFORE = backlog_kg - current_available_capacity_kg
  // (If current capacity is unknown, GAP_BEFORE = UNKNOWN)
  //
  // CAPACITY_GAP_AFTER = max(0, GAP_BEFORE - vehicle_added_kg)
  // (If either is unknown, GAP_AFTER = UNKNOWN)

  const currentCapacityKg: number | null =
    typeof (facts as any).currentAvailableCapacityKg === "number"
      ? (facts as any).currentAvailableCapacityKg
      : null;

  const currentCapacityOrders: number | null =
    typeof (facts as any).currentAvailableCapacityOrders === "number"
      ? (facts as any).currentAvailableCapacityOrders
      : null;

  let gapBeforeDisplay: string;
  let gapBeforeKg: number | null = null;

  if (currentCapacityKg === null || facts.currentKg === null) {
    gapBeforeDisplay = "UNKNOWN (Chưa xác định năng lực xử lý/xuất hàng hiện có của trạm)";
  } else {
    gapBeforeKg = Math.max(0, facts.currentKg - currentCapacityKg);
    gapBeforeDisplay = `${gapBeforeKg} kg`;
  }

  switch (optionType) {
    case "NO_ACTION_MONITOR": {
      const gapAfterDisplay =
        gapBeforeKg !== null
          ? `${gapBeforeKg} kg (Giữ nguyên năng lực hiện có)`
          : "UNKNOWN (Giữ nguyên hiện trạng - công suất trạm chưa rõ)";

      return {
        current_capacity_kg: currentCapacityKg,
        current_capacity_orders: currentCapacityOrders,
        added_kg: 0,
        added_orders: 0,
        added_vehicle_days: 0,
        resulting_capacity_kg: currentCapacityKg,
        capacity_gap_before: gapBeforeDisplay,
        capacity_gap_after: gapAfterDisplay,
        status: "MEASURED",
      };
    }

    case "REQUEST_MORE_INFORMATION": {
      const gapAfterDisplay =
        gapBeforeKg !== null
          ? `${gapBeforeKg} kg (Chờ bổ sung thông tin)`
          : "UNKNOWN (Chờ bổ sung thông tin công suất & hạn SLA)";

      return {
        current_capacity_kg: currentCapacityKg,
        current_capacity_orders: currentCapacityOrders,
        added_kg: 0,
        added_orders: 0,
        added_vehicle_days: 0,
        resulting_capacity_kg: currentCapacityKg,
        capacity_gap_before: gapBeforeDisplay,
        capacity_gap_after: gapAfterDisplay,
        status: "MEASURED",
      };
    }

    case "ADD_VEHICLE": {
      if (capacityEvidence && capacityEvidence.usable_payload_kg !== null) {
        const addedKg = capacityEvidence.usable_payload_kg;
        const resultingCapKg = currentCapacityKg !== null ? currentCapacityKg + addedKg : null;
        let gapAfterDisplay = "UNKNOWN";
        if (gapBeforeKg !== null) {
          const rem = Math.max(0, gapBeforeKg - addedKg);
          gapAfterDisplay = `${rem} kg`;
        }

        return {
          current_capacity_kg: currentCapacityKg,
          current_capacity_orders: currentCapacityOrders,
          added_kg: addedKg,
          added_orders: null,
          added_vehicle_days: 1,
          resulting_capacity_kg: resultingCapKg,
          capacity_gap_before: gapBeforeDisplay,
          capacity_gap_after: gapAfterDisplay,
          status: capacityEvidence.evidence_status === "GOVERNED" ? "GOVERNED" : "MEASURED",
        };
      }

      return {
        current_capacity_kg: currentCapacityKg,
        current_capacity_orders: currentCapacityOrders,
        added_kg: null,
        added_orders: null,
        added_vehicle_days: null,
        resulting_capacity_kg: null,
        capacity_gap_before: gapBeforeDisplay,
        capacity_gap_after: "UNKNOWN (Chưa xác định tải trọng xe khả dụng)",
        status: "UNKNOWN",
      };
    }

    case "REALLOCATE_AVAILABLE_CAPACITY":
    case "ADD_MANPOWER":
    case "HOLD_LOW_PRIORITY_ECOM":
    case "HUMAN_INVESTIGATION_REQUIRED":
    default:
      return {
        current_capacity_kg: currentCapacityKg,
        current_capacity_orders: currentCapacityOrders,
        added_kg: null,
        added_orders: null,
        added_vehicle_days: null,
        resulting_capacity_kg: null,
        capacity_gap_before: gapBeforeDisplay,
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
