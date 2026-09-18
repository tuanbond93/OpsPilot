import type { CapacityAction, CurrentRisk, LeadFact } from "../loop";

export type RootCauseCategory =
  | "TRANSPORT_CAPACITY_SHORTAGE"
  | "MANPOWER_SHORTAGE"
  | "INCOMING_VOLUME_RISK"
  | "PROCESS_DELAY"
  | "BACKLOG_AGING_RISK"
  | "BACKLOG_ACCUMULATION"
  | "CAPACITY_CAUSE_UNKNOWN"
  | "NO_MATERIAL_GAP"
  | "NO_MATERIAL_CAPACITY_GAP"
  | "UNKNOWN";

export interface RootCauseEvaluation {
  category: RootCauseCategory;
  confidence: number;
  evidence: string[];
  unknowns: string[];
  reasoning: string;
}

export type FeasibilityStatus =
  | "FEASIBLE"
  | "CONDITIONALLY_FEASIBLE"
  | "INFEASIBLE"
  | "UNKNOWN";

export type EconomicStatus = "JUSTIFIED" | "NOT_JUSTIFIED" | "UNKNOWN";

export interface DecisionOptionEconomic {
  status: EconomicStatus;
  reason: string | null;
}

export type OptionCostStatus = "MEASURED" | "GOVERNED_RATE" | "MODELED" | "UNKNOWN";

export interface DecisionOptionCost {
  incremental_cost_vnd: number | null;
  /** @deprecated Use incremental_cost_vnd */
  value_vnd?: number | null;
  evidence_status: OptionCostStatus;
  source: string | null;
  notes?: string;
}

export type OptionCapacityStatus = "MEASURED" | "GOVERNED" | "MODELED" | "UNKNOWN";

export interface DecisionOptionCapacity {
  current_capacity_kg: number | null;
  current_capacity_orders: number | null;
  added_kg: number | null;
  added_orders: number | null;
  added_vehicle_days: number | null;
  resulting_capacity_kg: number | null;
  capacity_gap_before: string | null;
  capacity_gap_after: string | null;
  status: OptionCapacityStatus;
}

export type SlaProjectedEffect = "IMPROVE" | "NEUTRAL" | "WORSEN" | "UNKNOWN";
export type SlaBreachRisk = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type SlaEvidenceStatus = "MEASURED" | "GOVERNED" | "MODELED" | "UNKNOWN";

export interface DecisionOptionSla {
  projected_effect: SlaProjectedEffect;
  projected_clearance_at: string | null;
  breach_risk: SlaBreachRisk;
  evidence_status: SlaEvidenceStatus;
  confidence: number;
  evidence: string[];
}

export interface DecisionOption {
  option_id: string;
  option_type: CapacityAction | "REQUEST_MORE_INFORMATION";
  description: string;
  feasibility_status: FeasibilityStatus;
  feasibility_reason: string | null;
  feasibility_evidence?: string | null;
  /** @deprecated Use feasibility_reason */
  infeasible_reason?: string | null;
  economic: DecisionOptionEconomic;
  economic_status?: EconomicStatus;
  economic_reason?: string | null;
  economic_evidence?: string | null;
  evidence_refs: string[];
  cost: DecisionOptionCost;
  capacity: DecisionOptionCapacity;
  sla: DecisionOptionSla;
  operational_effect: {
    description: string;
  };
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  confidence: number;
  /** Convenience boolean: true only when feasibility_status === "FEASIBLE" */
  feasible: boolean;
}

export interface MultiOptionMatrixRow {
  option: string;
  option_type: string;
  feasibility_status: FeasibilityStatus;
  feasibility_reason: string | null;
  feasibility_evidence?: string | null;
  economic_status: EconomicStatus;
  economic_evidence?: string | null;
  incremental_cost_display: string;
  cost_display?: string;
  capacity_impact: string;
  sla_impact: string;
  main_risk: string;
  unknown_fields: string[];
  feasible?: boolean;
}

export interface MultiOptionMatrix {
  case_id: string;
  warehouse_id: string;
  warehouse_name: string;
  root_cause: RootCauseEvaluation;
  rows: MultiOptionMatrixRow[];
  options: DecisionOption[];
}

export interface MultiOptionDecisionResult {
  decision_case_id: string;
  root_cause: RootCauseEvaluation;
  matrix: MultiOptionMatrix;
  candidate_options: DecisionOption[];
  recommended_option: CapacityAction | "REQUEST_MORE_INFORMATION" | "INSUFFICIENT_EVIDENCE";
  recommendation_reason: string;
  tradeoff_summary: string;
  confidence: number;
  critic_verdict: "VALID" | "INVALID";
  critic_flags: string[];
  missing_data: string[];
  requested_information?: string[];
  persistedEventId?: string;
  generatedAt?: string;
}
