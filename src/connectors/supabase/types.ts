export type SyncRunStatus = "running" | "success" | "failed";
export type IncidentDbStatus = "open" | "monitoring" | "resolved" | "ignored";
export type ExceptionReasonCode =
  | "CUSTOMER_APPOINTMENT"
  | "MISSING_PACKAGE"
  | "MISSING_DOCUMENT"
  | "DAMAGED"
  | "CS_RESCHEDULED";

export interface SyncRunRow {
  id: string;
  started_at: string;
  completed_at?: string | null;
  status: SyncRunStatus;
  fetched_order_count: number;
  normalized_order_count: number;
  incident_count: number;
  duration_ms?: number | null;
  source_updated_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
}

export interface OrderSnapshotRow {
  id?: number;
  sync_run_id: string;
  order_code: string;
  warehouse_id?: string | null;
  warehouse_name?: string | null;
  source_status: string;
  task_category?: string | null;
  reason_code?: string | null;
  order_created_at?: string | null;
  source_updated_at?: string | null;
  age_hours?: number | null;
  created_at?: string;
}

export interface IncidentRow {
  id: string;
  incident_key: string;
  warehouse_id: string;
  warehouse_name?: string | null;
  reason_code: string;
  reason_name: string;
  status: IncidentDbStatus;
  priority_score: number;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at?: string | null;
  last_sync_run_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface IncidentHistoryRow {
  id?: number;
  incident_id: string;
  sync_run_id: string;
  recorded_at: string;
  affected_order_count: number;
  average_age_hours?: number | null;
  maximum_age_hours?: number | null;
  oldest_order_code?: string | null;
  priority_score: number;
  sample_order_codes: string[];
  created_at?: string;
}

export interface OrderExceptionRow {
  id: string;
  order_code: string;
  reason_code: ExceptionReasonCode;
  reason_name: string;
  note?: string | null;
  approved_by?: string | null;
  starts_at: string;
  expires_at?: string | null;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}
