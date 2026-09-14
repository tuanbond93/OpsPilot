import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_CHECKPOINT_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = 5 * 60_000;

// Legacy values remain supported in the database for historical rows only.
export type CheckpointRecoveryStatus = "PENDING" | "DISPATCHING" | "RUNNING" | "CONFIRMED" | "FAILED_REQUIRES_ATTENTION";
export type RecoveryCompletion = "CONFIRMED" | "RETRYABLE" | "FAILED_REQUIRES_ATTENTION";

export type CheckpointRecoveryInput = {
  checkpointAt: string;
  scheduledFor: string;
  failureStage: string;
  lastSafeError: string;
};

const safeError = (value: string) => value.slice(0, 500);

export function isRetryableRecoveryHttpOutcome(input: { statusCode?: number | null; timedOut?: boolean; error?: string | null }): boolean {
  if (input.timedOut) return true;
  if (input.statusCode != null) return input.statusCode >= 500 && input.statusCode <= 599;
  return Boolean(input.error && /(timeout|gateway|network|econn|connection)/i.test(input.error));
}

export function nextRecoveryAttemptAt(attemptCount: number, now = Date.now()): string {
  return new Date(now + RECOVERY_BACKOFF_MS * Math.max(1, attemptCount)).toISOString();
}

export async function queueCheckpointRecovery(client: SupabaseClient, input: CheckpointRecoveryInput): Promise<void> {
  const { error } = await client.from("checkpoint_recoveries").upsert({
    checkpoint_at: input.checkpointAt,
    recovery_attempt: 0,
    status: "PENDING",
    scheduled_for: input.scheduledFor,
    next_attempt_at: input.scheduledFor,
    failure_stage: input.failureStage,
    last_safe_error: safeError(input.lastSafeError),
  }, { onConflict: "checkpoint_at", ignoreDuplicates: true });
  if (error) throw error;
}

export async function claimCheckpointRecovery(client: SupabaseClient, checkpointAt: string, recoveryToken: string) {
  const { data, error } = await client.from("checkpoint_recoveries")
    .update({ status: "RUNNING", started_at: new Date().toISOString() })
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_token", recoveryToken)
    .eq("status", "DISPATCHING")
    .select("checkpoint_at")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function finishCheckpointRecovery(
  client: SupabaseClient,
  checkpointAt: string,
  recoveryToken: string,
  result: { status: RecoveryCompletion; syncRunId?: string; failureStage?: string; lastSafeError?: string; lastHttpStatus?: number | null; lastRequestId?: number | null }
): Promise<void> {
  const base: Record<string, unknown> = {
    completed_at: new Date().toISOString(),
    sync_run_id: result.syncRunId || null,
    failure_stage: result.failureStage || null,
    last_safe_error: result.lastSafeError ? safeError(result.lastSafeError) : null,
  };
  if (result.lastHttpStatus !== undefined) base.last_http_status = result.lastHttpStatus;
  if (result.lastRequestId !== undefined) base.last_request_id = result.lastRequestId;
  const scoped = (status: CheckpointRecoveryStatus) => client.from("checkpoint_recoveries")
    .update({ ...base, status })
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_token", recoveryToken)
    .eq("status", "RUNNING");

  if (result.status === "CONFIRMED" || result.status === "FAILED_REQUIRES_ATTENTION") {
    const { error } = await scoped(result.status);
    if (error) throw error;
    return;
  }

  const { data: current, error: readError } = await client.from("checkpoint_recoveries")
    .select("recovery_attempt")
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_token", recoveryToken)
    .eq("status", "RUNNING")
    .maybeSingle();
  if (readError) throw readError;
  const attemptCount = Number(current?.recovery_attempt || 0);
  if (attemptCount >= MAX_CHECKPOINT_RECOVERY_ATTEMPTS) {
    const { error } = await scoped("FAILED_REQUIRES_ATTENTION");
    if (error) throw error;
    return;
  }
  const { error } = await client.from("checkpoint_recoveries")
    .update({ ...base, status: "PENDING", completed_at: null, next_attempt_at: nextRecoveryAttemptAt(attemptCount), recovery_token: null })
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_token", recoveryToken)
    .eq("status", "RUNNING");
  if (error) throw error;
}
