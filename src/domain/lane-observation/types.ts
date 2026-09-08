import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";

export type CotResolutionStatus = "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS";
export type CotResult = "MET" | "MISSED" | "UNKNOWN";

export interface PilotLane {
  fromWarehouseId: string;
  fromWarehouseName: string;
  toWarehouseId: string;
  toWarehouseName: string;
}

export interface LaneOrderObservationRow {
  id?: string;
  sync_run_id: string;
  order_code: string;
  observed_at: string;
  source_status: string;
  current_warehouse_id?: string | null;
  current_warehouse_name?: string | null;
  deliver_warehouse_id?: string | null;
  deliver_warehouse_name?: string | null;
  destination_province_id?: string | null;
  destination_district_id?: string | null;
  end_pick_at?: string | null;
  weight_kg?: number | null;
  warehouse_log_evidence: unknown[];
  pilot_lane_from_id: string;
  pilot_lane_to_id: string;
  current_warehouse_first_observed_at: string;
  resolved_cut_off_receive?: string | null;
  cot_resolution_status: CotResolutionStatus;
}

export interface LaneTransitionObservationRow {
  id?: string;
  order_code: string;
  from_warehouse_id: string;
  from_warehouse_name?: string | null;
  to_warehouse_id: string;
  to_warehouse_name?: string | null;
  transition_window_start: string;
  transition_window_end: string;
  first_observed_at_from: string;
  last_observed_at_from: string;
  first_observed_at_to: string;
  source_event_at?: string | null;
  receive_observed_at?: string | null;
  applicable_receive_cot?: string | null;
  cot_result: CotResult;
  source_observation_id: string;
  target_observation_id: string;
}

export interface LaneObservationRepository {
  getLatestByOrderCodes(orderCodes: string[]): Promise<Map<string, LaneOrderObservationRow>>;
  appendOrderObservations(rows: LaneOrderObservationRow[]): Promise<LaneOrderObservationRow[]>;
  appendTransitions(rows: LaneTransitionObservationRow[]): Promise<number>;
  getCompletedTransitions(fromWarehouseId: string, toWarehouseId: string): Promise<LaneTransitionObservationRow[]>;
}

export interface CotResolution {
  status: CotResolutionStatus;
  cutOffReceive?: string | null;
}

export type CotResolver = (order: NormalizedRillnetOrder, lane: PilotLane, observedAt: string) => CotResolution;
