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
  warehouse_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
  expires_at?: string | null;
  created_at?: string;
}

export type FollowupState =
  | "NEW"
  | "FIRST_PUSH_PENDING"
  | "FIRST_PUSH_SENT"
  | "FOLLOWING_UP"
  | "SECOND_PUSH_PENDING"
  | "SECOND_PUSH_SENT"
  | "ESCALATION_PENDING"
  | "ESCALATED"
  | "RESOLVED"
  | "CLOSED";

export type ProgressAssessment =
  | "strong_progress"
  | "limited_progress"
  | "no_progress"
  | "worsening"
  | "insufficient_data";

export type FollowupEventType =
  | "CASE_CREATED"
  | "PUSH_REQUESTED"
  | "PUSH_CONFIRMED"
  | "ASSESSMENT_CHECKED"
  | "ESCALATION_REQUESTED"
  | "ESCALATION_CONFIRMED"
  | "INCIDENT_RESOLVED"
  | "CASE_CLOSED"
  | "CASE_REOPENED";

export interface FollowupCaseRow {
  id: string;
  incident_id: string; // UUID FK referencing incidents(id)
  incident_key: string;
  current_state: FollowupState;
  first_detected_at: string;
  last_checked_at: string;
  next_action_at?: string | null;
  last_action_requested_at?: string | null;
  last_action_confirmed_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  baseline_affected_order_count: number;
  latest_affected_order_count: number;
  current_progress_percent: number;
  current_assessment: ProgressAssessment;
  created_at?: string;
  updated_at?: string;
}

export interface FollowupEventRow {
  id: string;
  followup_case_id: string;
  event_type: FollowupEventType;
  event_time: string;
  snapshot_id?: string | null;
  old_state: FollowupState;
  new_state: FollowupState;
  assessment: ProgressAssessment;
  confirmed_by?: string | null;
  notes?: string | null;
  created_at?: string;
}

export type PlannerRunStatus = "DRAFT" | "APPROVED" | "REJECTED" | "EXPIRED";
export type PlannerReviewEventType = "CREATED" | "APPROVED" | "REJECTED" | "EXPIRED" | "REGENERATED";

export interface PlannerRunRow {
  id: string;
  incident_id: string;
  followup_case_id?: string | null;
  status: PlannerRunStatus;
  context_hash: string;
  prompt_version: number;
  provider: string;
  model: string;
  result: Record<string, unknown>;
  created_at?: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
}

export interface PlannerReviewEventRow {
  id: string;
  planner_run_id: string;
  event_type: PlannerReviewEventType;
  actor: string;
  note?: string | null;
  created_at?: string;
}

export type AiJobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type AiJobPriority = "low" | "medium" | "high" | "urgent";

export interface AiAnalysisJobRow {
  id: string;
  incident_id: string;
  priority: AiJobPriority;
  status: AiJobStatus;
  attempt_count: number;
  max_attempts: number;
  scheduled_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  locked_at?: string | null;
  worker_id?: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
}