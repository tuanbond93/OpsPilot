export type ConsolidationVerdict = "ELIGIBLE_SHADOW" | "DISPATCH_NOW" | "HUMAN_INVESTIGATION_REQUIRED";

export type ConsolidationReasonCode =
  | "ELIGIBLE_FOR_MANAGER_REVIEW"
  | "SINGLE_ORDER_NO_CONSOLIDATION_BENEFIT"
  | "ROUTE_MISMATCH"
  | "TRIP_DEPARTS_BEFORE_ORDER_READY"
  | "SLA_WINDOW_WOULD_BE_BREACHED"
  | "CAPACITY_DATA_MISSING"
  | "ORDER_LOAD_DATA_MISSING"
  | "CAPACITY_INSUFFICIENT";

export interface ConsolidationTrip {
  tripId: string;
  originWarehouse: string;
  destinationWarehouse: string;
  departureAt: string;
  capacityKg?: number | null;
  bookedKg?: number | null;
  capacityM3?: number | null;
  bookedM3?: number | null;
}

export interface ConsolidationOrder {
  orderCode: string;
  readyAt: string;
  latestSafeDepartureAt: string;
  weightKg?: number | null;
  volumeM3?: number | null;
}

export interface ConsolidationAnalysisInput {
  trip: ConsolidationTrip;
  orders: ConsolidationOrder[];
}

export interface ConsolidationOption {
  option: "DISPATCH_NOW" | "HOLD_FOR_CONSOLIDATION";
  enabled: boolean;
  approvalRequired: boolean;
  description: string;
}

export interface ConsolidationAnalysis {
  mode: "SHADOW";
  verdict: ConsolidationVerdict;
  reasonCodes: ConsolidationReasonCode[];
  safeHoldUntil: string | null;
  trip: ConsolidationTrip;
  orders: ConsolidationOrder[];
  options: ConsolidationOption[];
  requiredChecks: string[];
  financialImpact: { status: "NOT_EVALUATED"; authority: "P15-B.1" };
}
