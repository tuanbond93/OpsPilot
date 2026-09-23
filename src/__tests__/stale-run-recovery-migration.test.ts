import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(process.cwd(), "src/database/migrations/093_stale_checkpoint_recovery_operator.sql"), "utf8");
const dispatcher = readFileSync(join(process.cwd(), "src/database/migrations/071_checkpoint_recovery_delivery_contract.sql"), "utf8");
const aiEnqueue = readFileSync(join(process.cwd(), "src/database/migrations/092_ai_enqueue_run_ledger.sql"), "utf8");

describe("stale checkpoint recovery database contract", () => {
  it("accepts only the exact resumable running checkpoint phase", () => {
    expect(migration).toContain("v_run.status IS DISTINCT FROM 'running'");
    expect(migration).toContain("v_run.completed_at IS NOT NULL");
    expect(migration).toContain("v_run.current_phase IS DISTINCT FROM 'ENQUEUE_NOTIFICATIONS'");
    expect(migration).toContain("@> '[\"ENQUEUE_AI\"]'::jsonb");
    expect(migration).toContain("PROCESSING_FOLLOWUPS\",\"ENQUEUE_NOTIFICATIONS");
  });

  it("rejects an active lease and serializes against lease acquisition", () => {
    expect(migration).toContain("LOCK TABLE public.sync_locks IN SHARE ROW EXCLUSIVE MODE");
    expect(migration).toContain("lock_key = 'global:rillnet-sync'");
    expect(migration).toContain("expires_at > v_now");
    expect(migration).toContain("'SYNC_LEASE_ACTIVE'");
  });

  it("rejects an unknown run and requires one canonical run per checkpoint", () => {
    expect(migration).toContain("WHERE id = p_sync_run_id");
    expect(migration).toContain("'RUN_NOT_FOUND'");
    expect(migration).toContain("WHERE checkpoint_at = v_run.checkpoint_at");
    expect(migration).toContain("IF v_run_count <> 1 THEN");
    expect(migration).toContain("'CHECKPOINT_RUN_NOT_UNIQUE'");
  });

  it("returns the existing recovery for the same run without mutating it", () => {
    expect(migration).toContain("IF v_recovery.sync_run_id = p_sync_run_id THEN");
    expect(migration).toContain("'outcome', 'ALREADY_QUEUED'");
    expect(migration).toContain("'CHECKPOINT_RECOVERY_EXISTS'");
    expect(migration).toContain("ON CONFLICT (checkpoint_at) DO NOTHING");
    expect(migration).not.toMatch(/UPDATE\s+public\.checkpoint_recoveries/i);
  });

  it("requires the complete RILLNET manifest and exact expected/persisted/distinct counts", () => {
    expect(migration).toContain("source_system = 'RILLNET'");
    expect(migration).toContain("population_status IS DISTINCT FROM 'COMPLETE'");
    expect(migration).toContain("duplicate_conflict_count <> 0");
    expect(migration).toContain("count(DISTINCT order_code)");
    expect(migration).toContain("v_observation_count <> v_manifest.expected_observation_count");
    expect(migration).toContain("v_distinct_order_count <> v_manifest.expected_observation_count");
  });

  it("leaves completed phases, population, and sync run data untouched", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.sync_runs/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.inbound_population_manifests/i);
    expect(migration).not.toMatch(/DELETE\s+FROM|TRUNCATE\s/i);
  });

  it("inserts a tokenless PENDING row only and does not invoke the dispatcher", () => {
    expect(migration).toContain("'PENDING'");
    expect(migration).toContain("    NULL,\n    p_sync_run_id,");
    expect(migration).toContain("'tokenPresent', false");
    expect(migration).not.toMatch(/gen_random_uuid|net\.http_post|dispatch_due_opspilot_checkpoint_recoveries/i);
    expect(migration).not.toMatch(/recovery_token\s*=\s*[^N]/i);
  });

  it("restricts the security-definer RPC to the service role with a safe search path", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.queue_stale_checkpoint_recovery_for_run(uuid) FROM PUBLIC");
    expect(migration).toContain("FROM anon, authenticated");
    expect(migration).toContain("TO service_role");
  });

  it("does not alter the existing dispatcher or AI enqueue contract", () => {
    expect(dispatcher).toContain("dispatch_due_opspilot_checkpoint_recoveries");
    expect(dispatcher).toContain("status = 'PENDING' AND coalesce(next_attempt_at, scheduled_for) <= now()");
    expect(aiEnqueue).toContain("enqueue_ai_analysis_jobs_for_sync_run");
    expect(aiEnqueue).toContain("REVOKE ALL ON FUNCTION public.enqueue_ai_analysis_jobs_for_sync_run(uuid)");
    expect(migration).not.toContain("dispatch_due_opspilot_checkpoint_recoveries");
    expect(migration).not.toContain("enqueue_ai_analysis_jobs_for_sync_run");
  });
});
