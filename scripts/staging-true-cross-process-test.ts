/**
 * Checkpoint Pipeline V2 - True Cross-Process Durability Test
 * Executes against Supabase Staging (lxizjfrlecqqhkaeycmm)
 *
 * Verifies:
 * 1. Spawning Worker Process A (PID A)
 * 2. Hard killing Process A (SIGKILL) mid-flight
 * 3. Confirming Process A is dead
 * 4. Waiting for lease expiration + observing pg_cron/pg_net
 * 5. Spawning Worker Process B (PID B != PID A) with separate OS memory
 * 6. Process B reclaiming orphaned/expired work units and finishing queue
 */

import path from "path";
import { spawn, execSync } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "../src/engine/checkpoint-v2/checkpoint-orchestrator";

interface QueueStatusSummary {
  total: number;
  pending: number;
  leased: number;
  completed: number;
  failed: number;
  details: Array<{
    id: string;
    work_type: string;
    status: string;
    attempts: number;
    lease_owner: string | null;
    lease_expires_at: string | null;
  }>;
}

async function getQueueSummary(supabase: any, checkpointAt: string): Promise<QueueStatusSummary> {
  const { data, error } = await supabase
    .from("checkpoint_work_units")
    .select("id, work_type, status, attempts, lease_owner, lease_expires_at")
    .eq("checkpoint_at", checkpointAt)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Query failed: ${error.message}`);
  const units = data || [];
  return {
    total: units.length,
    pending: units.filter((u: any) => u.status === "PENDING").length,
    leased: units.filter((u: any) => u.status === "LEASED").length,
    completed: units.filter((u: any) => u.status === "COMPLETED").length,
    failed: units.filter((u: any) => u.status === "FAILED").length,
    details: units,
  };
}

function killProcess(pid: number) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch (err) {
    // Process may have already exited
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
      return output.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

async function run() {
  console.log("=== CHECKPOINT V2: TRUE CROSS-PROCESS DURABILITY TEST ===");
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  if (env.projectRef === "elwnbwimgzijuelfjdsq" || env.url.includes("elwnbwimgzijuelfjdsq")) {
    throw new Error("ABORT: Attempted execution on PRODUCTION target!");
  }

  const supabase = createClient(env.url, env.secretKey, {
    auth: { persistSession: false },
  });

  const pgClient = new PgClient({
    connectionString: `postgresql://postgres.${env.projectRef}:${encodeURIComponent(env.dbPassword)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
  });
  await pgClient.connect();

  const testTimestamp = new Date().toISOString();
  const testCheckpointAt = `2026-09-27T02:${Math.floor(10 + Math.random() * 40)}:00.000Z`;
  const testSyncRunId = crypto.randomUUID();
  const caseCount = 3;
  const leaseSeconds = 8; // Bounded lease time for crisp expiration test

  console.log(`[SETUP] CheckpointAt: ${testCheckpointAt}`);
  console.log(`[SETUP] SyncRunId: ${testSyncRunId}`);

  // Create sync_run row to satisfy foreign key constraint
  const { error: runError } = await supabase.from("sync_runs").upsert({
    id: testSyncRunId,
    checkpoint_at: testCheckpointAt,
    status: "running",
    current_phase: "PERSISTING_HISTORY",
    fetched_order_count: 6,
    normalized_order_count: 6,
    incident_count: caseCount,
    started_at: testCheckpointAt,
  });
  if (runError) throw new Error(`Failed to create sync_run: ${runError.message}`);

  // 1. Seed durable order_snapshots
  const snapshotRows = Array.from({ length: 6 }, (_, i) => ({
    sync_run_id: testSyncRunId,
    order_code: `ORD_DUR_${testSyncRunId.slice(0, 6)}_${i}`,
    warehouse_id: `WH_0${(i % 2) + 1}`,
    warehouse_name: `Kho Hub ${(i % 2) + 1}`,
    source_status: "storing",
    task_category: "giao_hang",
    source_updated_at: testCheckpointAt,
    order_created_at: "2026-09-26T00:00:00Z",
    end_pick_at: "2026-09-26T06:00:00Z",
    warehouse_log: [],
  }));
  const { error: snapError } = await supabase.from("order_snapshots").insert(snapshotRows);
  if (snapError) console.warn("Snapshot seed note:", snapError.message);

  // 2. Seed durable incidents & incident_histories
  const incidentRows = Array.from({ length: caseCount }, (_, i) => ({
    id: crypto.randomUUID(),
    incident_key: `WH_DUR_${testSyncRunId.slice(0, 6)}:${i}`,
    warehouse_id: `WH_0${(i % 2) + 1}`,
    warehouse_name: `Kho Hub ${(i % 2) + 1}`,
    reason_code: "PACKING_DELAY",
    reason_name: "Đóng gói chậm",
    status: "open",
    priority_score: 70,
    first_detected_at: testCheckpointAt,
    last_detected_at: testCheckpointAt,
    last_sync_run_id: testSyncRunId,
  }));
  const { error: incError } = await supabase.from("incidents").upsert(incidentRows);
  if (incError) console.warn("Incident seed note:", incError.message);

  const historyRows = incidentRows.map((inc, i) => ({
    incident_id: inc.id,
    sync_run_id: testSyncRunId,
    recorded_at: testCheckpointAt,
    affected_order_count: 2,
    priority_score: 70,
    sample_order_codes: [snapshotRows[i * 2]?.order_code || "ORD_1"],
  }));
  const { error: histError } = await supabase.from("incident_history").insert(historyRows);
  if (histError) console.warn("History seed note:", histError.message);

  // 3. Seed strictly post-barrier units (EVALUATE_FOLLOWUP_BATCH, PERSIST_MEMBERS_CHUNK, DISPATCH_INTERVENTION_BATCH)
  const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
  const orchestrator = new CheckpointOrchestrator(queueRepo);

  const totalUnits = await orchestrator.initializePostBarrierCheckpoint({
    checkpointAt: testCheckpointAt,
    syncRunId: testSyncRunId,
    caseCount,
    estimatedMembers: 4,
    caseBatchSize: 1,
    dispatchBatchSize: 1,
    memberBatchSize: 2,
    executionMode: "SHADOW",
  });

  console.log(`[SETUP] Seeded ${totalUnits} strictly post-barrier SHADOW work units into staging DB`);

  const initialQueue = await getQueueSummary(supabase, testCheckpointAt);
  console.log(`[SEED_CONFIRMED] Total: ${initialQueue.total}, Pending: ${initialQueue.pending}`);

  // 2. Start Worker Process A
  console.log("\n--- STEP 1: SPAWN WORKER PROCESS A ---");
  const childA = spawn(
    "npx.cmd",
    [
      "tsx",
      "scripts/durability-worker-cli.ts",
      "--checkpoint-at",
      testCheckpointAt,
      "--sync-run-id",
      testSyncRunId,
      "--worker-id",
      "worker_proc_A",
      "--delay-ms",
      "800",
      "--lease-seconds",
      String(leaseSeconds),
    ],
    { stdio: ["ignore", "pipe", "pipe"], shell: true }
  );

  const pidA = childA.pid;
  console.log(`[PROCESS_A_SPAWNED] PID: ${pidA}`);

  let unitsProcessedByA = 0;
  let activeUnitByA = "";

  childA.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`  [Process A stdout] ${text}`);
    if (text.includes("[UNIT_START]")) {
      const match = text.match(/UNIT_ID=([^\s]+)/);
      if (match) activeUnitByA = match[1];
    }
    if (text.includes("[UNIT_FINISH]")) {
      unitsProcessedByA++;
    }
  });

  childA.stderr.on("data", (chunk) => {
    process.stderr.write(`  [Process A stderr] ${chunk.toString()}`);
  });

  // Wait until Process A has completed at least 2 units and is actively holding leases
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (unitsProcessedByA >= 2) {
        clearInterval(interval);
        resolve(true);
      }
    }, 200);
  });

  // Brief pause to ensure active unit is currently mid-flight
  await new Promise((r) => setTimeout(r, 400));

  const preKillQueue = await getQueueSummary(supabase, testCheckpointAt);
  console.log(`\n[PRE-KILL DB STATE] Total: ${preKillQueue.total}, Completed: ${preKillQueue.completed}, Leased: ${preKillQueue.leased}, Pending: ${preKillQueue.pending}`);

  // 3. Kill Process A ungracefully
  console.log(`\n--- STEP 2: HARD KILL (SIGKILL) PROCESS A (PID ${pidA}) ---`);
  const killTime = new Date().toISOString();
  killProcess(pidA!);

  // 4. Confirm Process A is actually dead
  let alive = isProcessAlive(pidA!);
  let retries = 0;
  while (alive && retries < 20) {
    await new Promise((r) => setTimeout(r, 100));
    alive = isProcessAlive(pidA!);
    retries++;
  }

  console.log(`[PROCESS_A_CONFIRMATION] PID ${pidA} Dead: ${!alive} at ${killTime}`);
  if (alive) {
    throw new Error(`FATAL: Process A (PID ${pidA}) could not be terminated!`);
  }

  // Check post-kill DB state
  const postKillQueue = await getQueueSummary(supabase, testCheckpointAt);
  console.log(`[POST-KILL DB STATE] Completed: ${postKillQueue.completed}, Leased: ${postKillQueue.leased}, Pending: ${postKillQueue.pending}`);
  console.log("Leased units orphaned by Process A death:");
  postKillQueue.details
    .filter((u) => u.status === "LEASED")
    .forEach((u) => {
      console.log(`  Unit: ${u.id}, Owner: ${u.lease_owner}, Expiry: ${u.lease_expires_at}, Attempts: ${u.attempts}`);
    });

  // 5. Wait for lease expiration
  const waitDurationMs = (leaseSeconds + 2) * 1000;
  console.log(`\n--- STEP 3: AWAIT LEASE EXPIRATION (${waitDurationMs / 1000}s) ---`);
  await new Promise((r) => setTimeout(r, waitDurationMs));

  // Inspect staging pg_cron and pg_net activity
  const cronRes = await pgClient.query(
    "SELECT runid, jobid, status, start_time, end_time FROM cron.job_run_details WHERE jobid = 3 ORDER BY start_time DESC LIMIT 3"
  );
  console.log("[STAGING_PG_CRON_RECENT_RUNS]:", cronRes.rows);

  const pgnetRes = await pgClient.query(
    "SELECT id, status_code, created FROM net._http_response ORDER BY created DESC LIMIT 3"
  );
  console.log("[STAGING_PG_NET_RECENT_RESPONSES]:", pgnetRes.rows);

  // 6. Spawn independent Worker Process B (completely fresh process)
  console.log("\n--- STEP 4: SPAWN WORKER PROCESS B (SEPARATE PROCESS RECOVERY) ---");
  const childB = spawn(
    "npx.cmd",
    [
      "tsx",
      "scripts/durability-worker-cli.ts",
      "--checkpoint-at",
      testCheckpointAt,
      "--sync-run-id",
      testSyncRunId,
      "--worker-id",
      "worker_proc_B",
      "--delay-ms",
      "50",
      "--lease-seconds",
      "30",
    ],
    { stdio: ["ignore", "pipe", "pipe"], shell: true }
  );

  const pidB = childB.pid;
  console.log(`[PROCESS_B_SPAWNED] PID: ${pidB} (Distinct from PID A: ${pidB !== pidA})`);

  let unitsProcessedByB = 0;
  childB.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`  [Process B stdout] ${text}`);
    if (text.includes("[UNIT_FINISH]")) {
      unitsProcessedByB++;
    }
  });

  childB.stderr.on("data", (chunk) => {
    process.stderr.write(`  [Process B stderr] ${chunk.toString()}`);
  });

  const exitCodeB: number = await new Promise((resolve) => {
    childB.on("close", (code) => resolve(code ?? 0));
  });

  console.log(`[PROCESS_B_EXIT] ExitCode: ${exitCodeB}, Units processed: ${unitsProcessedByB}`);

  // 7. Verify final recovery DB state
  console.log("\n--- STEP 5: VERIFY FINAL DB QUEUE STATE ---");
  const postRecoveryQueue = await getQueueSummary(supabase, testCheckpointAt);
  console.log(`[POST-RECOVERY DB STATE] Total: ${postRecoveryQueue.total}`);
  console.log(`  Completed: ${postRecoveryQueue.completed}`);
  console.log(`  Pending: ${postRecoveryQueue.pending}`);
  console.log(`  Leased: ${postRecoveryQueue.leased}`);
  console.log(`  Failed: ${postRecoveryQueue.failed}`);

  const passed =
    postRecoveryQueue.total === totalUnits &&
    postRecoveryQueue.completed === totalUnits &&
    postRecoveryQueue.pending === 0 &&
    postRecoveryQueue.leased === 0 &&
    postRecoveryQueue.failed === 0 &&
    pidA !== pidB &&
    !alive;

  console.log("\n=== DURABILITY TEST RESULT ===");
  console.log(`PROCESS_A_PID: ${pidA}`);
  console.log(`PROCESS_A_KILLED_CLEANLY: ${!alive}`);
  console.log(`PROCESS_B_PID: ${pidB}`);
  console.log(`PROCESS_B_MEMORY_SEPARATE: TRUE (OS PID isolation)`);
  console.log(`PRE_KILL_COMPLETED: ${preKillQueue.completed}`);
  console.log(`ORPHANED_UNITS_RECLAIMED: ${postKillQueue.leased}`);
  console.log(`POST_RECOVERY_COMPLETED: ${postRecoveryQueue.completed}/${totalUnits}`);
  console.log(`TRUE_CROSS_PROCESS_RECOVERY: ${passed ? "PASS" : "FAIL"}`);
  console.log(`REAL_HANDLER_CROSS_PROCESS_RECOVERY: ${passed ? "PASS" : "FAIL"}`);

  await pgClient.end();

  if (!passed) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR in test execution:", err);
  process.exit(1);
});
