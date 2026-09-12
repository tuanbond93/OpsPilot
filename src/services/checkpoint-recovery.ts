import type { SupabaseClient } from "@supabase/supabase-js";

export type CheckpointRecoveryStatus = "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type CheckpointRecoveryInput = {
  checkpointAt: string;
  scheduledFor: string;
  failureStage: string;
  lastSafeError: string;
};

const safeError = (value: string) => value.slice(0, 500);

export async function queueCheckpointRecovery(client: SupabaseClient, input: CheckpointRecoveryInput): Promise<void> {
  const { error } = await client.from("checkpoint_recoveries").upsert({
    checkpoint_at: input.checkpointAt,
    recovery_attempt: 1,
    status: "PENDING",
    scheduled_for: input.scheduledFor,
    failure_stage: input.failureStage,
    last_safe_error: safeError(input.lastSafeError),
  }, { onConflict: "checkpoint_at", ignoreDuplicates: true });
  if (error) throw error;
}

export async function claimCheckpointRecovery(client: SupabaseClient, checkpointAt: string, recoveryToken: string) {
  const { data, error } = await client.from("checkpoint_recoveries")
    .update({ status: "RUNNING", started_at: new Date().toISOString() })
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_attempt", 1)
    .eq("recovery_token", recoveryToken)
    .eq("status", "DISPATCHED")
    .select("checkpoint_at")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function finishCheckpointRecovery(
  client: SupabaseClient,
  checkpointAt: string,
  recoveryToken: string,
  result: { status: "SUCCEEDED" | "FAILED"; syncRunId?: string; failureStage?: string; lastSafeError?: string }
): Promise<void> {
  const { error } = await client.from("checkpoint_recoveries")
    .update({
      status: result.status,
      completed_at: new Date().toISOString(),
      sync_run_id: result.syncRunId || null,
      failure_stage: result.failureStage || null,
      last_safe_error: result.lastSafeError ? safeError(result.lastSafeError) : null,
    })
    .eq("checkpoint_at", checkpointAt)
    .eq("recovery_attempt", 1)
    .eq("recovery_token", recoveryToken)
    .eq("status", "RUNNING");
  if (error) throw error;
}
