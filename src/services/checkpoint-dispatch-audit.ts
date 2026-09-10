import type { SupabaseClient } from "@supabase/supabase-js";

export type CheckpointDispatchAuditInput = {
  syncRunId?: string | null;
  checkpointAt: string;
  startedAt: string;
  completedAt: string;
  executionStatus: "SUCCESS" | "FAILED";
  httpStatus?: number | null;
  supportedCasesEvaluated?: number | null;
  khoTonEvaluated?: number | null;
  khoChuaLuanChuyenEvaluated?: number | null;
  firstPushPendingCreated?: number | null;
  secondPushPendingCreated?: number | null;
  thirdPushPendingCreated?: number | null;
  escalationPendingCreated?: number | null;
  totalDispatchEligiblePending?: number | null;
  telegramScanned?: number | null;
  recipientsResolved?: number | null;
  interactionsCreated?: number | null;
  sendAttempts?: number | null;
  sendSuccess?: number | null;
  sendFailed?: number | null;
  statusUpdatesActive?: number | null;
  statusUpdatesResolved?: number | null;
  statusUpdateBatchesSent?: number | null;
  statusUpdateBatchesFailed?: number | null;
  exclusionCounts?: Record<string, number> | null;
  errorCode?: string | null;
  errorMessageSafe?: string | null;
};

const count = (value?: number | null) => value == null || !Number.isFinite(value) ? null : Math.max(0, Math.trunc(value));

export async function persistCheckpointDispatchAudit(client: SupabaseClient, input: CheckpointDispatchAuditInput): Promise<void> {
  const { error } = await client.from("checkpoint_dispatch_audits").insert({
    sync_run_id: input.syncRunId || null,
    checkpoint_at: input.checkpointAt,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    execution_status: input.executionStatus,
    http_status: input.httpStatus ?? null,
    supported_cases_evaluated: count(input.supportedCasesEvaluated),
    kho_ton_evaluated: count(input.khoTonEvaluated),
    kho_chua_luan_chuyen_evaluated: count(input.khoChuaLuanChuyenEvaluated),
    first_push_pending_created: count(input.firstPushPendingCreated),
    second_push_pending_created: count(input.secondPushPendingCreated),
    third_push_pending_created: count(input.thirdPushPendingCreated),
    escalation_pending_created: count(input.escalationPendingCreated),
    total_dispatch_eligible_pending: count(input.totalDispatchEligiblePending),
    telegram_scanned: count(input.telegramScanned),
    recipients_resolved: count(input.recipientsResolved),
    interactions_created: count(input.interactionsCreated),
    send_attempts: count(input.sendAttempts),
    send_success: count(input.sendSuccess),
    send_failed: count(input.sendFailed),
    status_updates_active: count(input.statusUpdatesActive),
    status_updates_resolved: count(input.statusUpdatesResolved),
    status_update_batches_sent: count(input.statusUpdateBatchesSent),
    status_update_batches_failed: count(input.statusUpdateBatchesFailed),
    exclusion_counts: input.exclusionCounts || null,
    error_code: input.errorCode || null,
    error_message_safe: input.errorMessageSafe || null,
  });
  if (error && error.code !== "23505") throw error;
}
