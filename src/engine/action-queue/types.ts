export type ActionStatus =
  | "PENDING"
  | "PROCESSING"
  | "SENT"
  | "SIMULATED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type DeliveryOutcome = "DELIVERED" | "SIMULATED" | "FAILED";

export type ActionType =
  | "FIRST_PUSH"
  | "SECOND_PUSH"
  | "ESCALATION"
  | "ROOTCAUSE_SUMMARY"
  | "DAILY_REPORT"
  | "WARNING"
  | "SYSTEM"
  | "CUSTOM";

export type TargetType =
  | "WAREHOUSE"
  | "LEAD"
  | "MANAGER"
  | "EXECUTIVE"
  | "SYSTEM";

export type ActionPriority = "low" | "medium" | "high" | "urgent";

export type AuditEventType =
  | "ACTION_ENQUEUED"
  | "ACTION_DEDUPLICATED"
  | "ACTION_CLAIMED"
  | "DELIVERY_SUCCEEDED"
  | "DELIVERY_SIMULATED"
  | "DELIVERY_FAILED"
  | "RETRY_SCHEDULED"
  | "ACTION_CANCELLED"
  | "ACTION_EXPIRED"
  | "PROCESSING_RECOVERED"
  | "MANUAL_CONFIRMED";

export interface NotificationActionRow {
  id: string;
  action_type: ActionType;
  provider: string;
  target_type: TargetType;
  target_id?: string | null;
  payload: Record<string, unknown>;
  status: ActionStatus;
  priority: ActionPriority;
  deduplication_key?: string | null;
  retry_count: number;
  max_retry: number;
  scheduled_at: string;
  started_at?: string | null;
  processed_at?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  attempt_started_at?: string | null;
  provider_message_id?: string | null;
  outcome?: DeliveryOutcome | null;
  last_error?: string | null;
  provider_response?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

export interface NotificationActionEventRow {
  id: string;
  action_id: string;
  event_type: AuditEventType;
  old_status?: ActionStatus | null;
  new_status?: ActionStatus | null;
  attempt_number: number;
  provider?: string | null;
  provider_message_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface EnqueueActionParams {
  actionType: ActionType;
  provider?: string;
  targetType?: TargetType;
  targetId?: string;
  payload: Record<string, unknown>;
  priority?: ActionPriority;
  deduplicationKey?: string;
  scheduledAt?: string;
  maxRetry?: number;
}
