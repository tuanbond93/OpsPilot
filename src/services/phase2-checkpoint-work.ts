import type { SupabaseClient } from "@supabase/supabase-js";
import { isTransientInfrastructureError } from "@/services/transient-infrastructure";
import { getRuntimeErrorDetails } from "@/observability/runtimeDiagnostics";

export const MAX_PHASE2_CHECKPOINT_ATTEMPTS = 3;
const BACKOFF_MS = 5 * 60_000;

export type Phase2WorkStatus = "PENDING" | "DISPATCHING" | "RUNNING" | "COMPLETED" | "FAILED";

const safeError = (error: unknown) => getRuntimeErrorDetails(error).message.slice(0, 500);

export async function queuePhase2CheckpointWork(client: SupabaseClient, input: { checkpointAt: string; syncRunId: string }) {
  const { error } = await client.from("phase2_checkpoint_work").upsert({
    checkpoint_at: input.checkpointAt,
    sync_run_id: input.syncRunId,
    status: "PENDING",
    next_attempt_at: new Date().toISOString(),
  }, { onConflict: "checkpoint_at", ignoreDuplicates: true });
  if (error) throw error;
}

export async function claimPhase2CheckpointWork(client: SupabaseClient, input: { checkpointAt: string; dispatchToken: string }) {
  const { data, error } = await client.from("phase2_checkpoint_work")
    .update({ status: "RUNNING", started_at: new Date().toISOString() })
    .eq("checkpoint_at", input.checkpointAt).eq("dispatch_token", input.dispatchToken).eq("status", "DISPATCHING")
    .select("sync_run_id").maybeSingle();
  if (error) throw error;
  return data as { sync_run_id: string } | null;
}

export async function finishPhase2CheckpointWork(client: SupabaseClient, input: { checkpointAt: string; dispatchToken: string; outcome: "COMPLETED" | "FAILED" | "RETRYABLE"; error?: unknown }) {
  const base = { completed_at: new Date().toISOString(), last_safe_error: input.error ? safeError(input.error) : null };
  if (input.outcome === "COMPLETED" || input.outcome === "FAILED") {
    const { error } = await client.from("phase2_checkpoint_work").update({ ...base, status: input.outcome })
      .eq("checkpoint_at", input.checkpointAt).eq("dispatch_token", input.dispatchToken).eq("status", "RUNNING");
    if (error) throw error;
    return;
  }
  const { data, error: readError } = await client.from("phase2_checkpoint_work").select("attempt_count")
    .eq("checkpoint_at", input.checkpointAt).eq("dispatch_token", input.dispatchToken).eq("status", "RUNNING").maybeSingle();
  if (readError) throw readError;
  const attempts = Number(data?.attempt_count || 0);
  const patch = attempts >= MAX_PHASE2_CHECKPOINT_ATTEMPTS
    ? { ...base, status: "FAILED" }
    : { ...base, status: "PENDING", completed_at: null, dispatch_token: null, next_attempt_at: new Date(Date.now() + BACKOFF_MS * Math.max(1, attempts)).toISOString() };
  const { error } = await client.from("phase2_checkpoint_work").update(patch)
    .eq("checkpoint_at", input.checkpointAt).eq("dispatch_token", input.dispatchToken).eq("status", "RUNNING");
  if (error) throw error;
}

export function phase2FailureOutcome(error: unknown): "RETRYABLE" | "FAILED" {
  return isTransientInfrastructureError(error) ? "RETRYABLE" : "FAILED";
}
