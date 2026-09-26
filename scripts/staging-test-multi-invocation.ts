import path from "path";
import { createClient } from "@supabase/supabase-js";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { CheckpointShadowRunner } from "../src/engine/checkpoint-v2/checkpoint-shadow-runner";

async function runMultiInvocationTest() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  if (env.projectRef === "elwnbwimgzijuelfjdsq") {
    console.error("FATAL: Target is production database! Aborting immediately.");
    process.exit(1);
  }

  const supabase = createClient(env.url, env.secretKey, { auth: { persistSession: false } });
  const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
  const shadowRunner = new CheckpointShadowRunner(queueRepo);

  console.log("=== OPSPILOT V2 — MULTI-INVOCATION CONTINUATION & HTTP DURATIONS ===");
  console.log(`Target: Staging (${env.projectRef})`);

  // Clear telemetry
  await fetch("http://127.0.0.1:3005/admin/clear-telemetry", { method: "POST" });

  const checkpointAt = new Date().toISOString();
  const syncRunId = crypto.randomUUID();

  // Create sync_run
  await supabase.from("sync_runs").upsert({
    id: syncRunId,
    checkpoint_at: checkpointAt,
    status: "running",
    started_at: checkpointAt,
  });

  // Seed 15 SHADOW work units (15,000 orders)
  console.log(`Seeding 15 SHADOW work units for checkpoint ${checkpointAt}...`);
  const seedResult = await shadowRunner.seedShadowCheckpoint({
    checkpointAt,
    syncRunId,
    orderCount: 15_000,
    incidentCount: 150,
  });
  console.log(`Seeded ${seedResult.unitsSeeded} units in ${seedResult.seedDurationMs}ms.`);

  const cronSecret = "ops-staging-cron-secret-2026";
  const workerEndpoint = "http://127.0.0.1:3005/api/internal/checkpoint-v2/worker?soft_budget_ms=1000&safe_tail_margin_ms=200";

  let iteration = 0;
  let allDone = false;
  const invocationStats: Array<{
    iteration: number;
    durationMs: number;
    claimed: number;
    completed: number;
    remainingInDb: number;
  }> = [];

  while (!allDone && iteration < 10) {
    iteration++;
    console.log(`\n--- Triggering HTTP Worker Invocation #${iteration} ---`);
    const t0 = performance.now();

    const response = await fetch(workerEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({}),
    });

    const elapsed = Math.round(performance.now() - t0);
    const data = await response.json();

    console.log(`HTTP Status: ${response.status}, Elapsed: ${elapsed}ms, Status: ${data.status}`);

    if (data.status === "IDLE") {
      console.log("Worker returned IDLE. Queue fully drained.");
      allDone = true;
      break;
    }

    const claimed = data.summary?.workUnitsClaimed || 0;
    const completed = data.summary?.workUnitsCompleted || 0;

    // Check remaining units directly in DB
    const { count: pendingOrLeased } = await supabase
      .from("checkpoint_work_units")
      .select("*", { count: "exact", head: true })
      .eq("checkpoint_at", checkpointAt)
      .eq("execution_mode", "SHADOW")
      .in("status", ["PENDING", "LEASED"]);

    invocationStats.push({
      iteration,
      durationMs: elapsed,
      claimed,
      completed,
      remainingInDb: pendingOrLeased || 0,
    });

    console.log(`Invocation #${iteration}: Claimed=${claimed}, Completed=${completed}, RemainingInDb=${pendingOrLeased}`);

    if (pendingOrLeased === 0) {
      allDone = true;
    }
  }

  // Verify all 15 units COMPLETED in DB
  const { count: totalCompleted } = await supabase
    .from("checkpoint_work_units")
    .select("*", { count: "exact", head: true })
    .eq("checkpoint_at", checkpointAt)
    .eq("execution_mode", "SHADOW")
    .eq("status", "COMPLETED");

  console.log(`\nTotal completed in DB: ${totalCompleted}/15`);

  // Assertions for Multi-Invocation Continuation
  const multiInvocationPassed =
    invocationStats.length >= 2 &&
    totalCompleted === 15 &&
    invocationStats[0].remainingInDb > 0 &&
    invocationStats[invocationStats.length - 1].remainingInDb === 0;

  console.log(`MULTI_INVOCATION_CONTINUATION: ${multiInvocationPassed ? "PASS" : "FAIL"}`);

  // Fetch telemetry to analyze unit timings
  const telemRes = await fetch("http://127.0.0.1:3005/telemetry");
  const telem = await telemRes.json();
  const durations = invocationStats.map((s) => s.durationMs).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1] || 0;
  const max = durations[durations.length - 1] || 0;

  console.log("\n==================== INVOCATION TIMINGS ====================");
  console.log(`Invocations: ${invocationStats.length}`);
  console.log(`P50: ${p50}ms`);
  console.log(`P95: ${p95}ms`);
  console.log(`Max: ${max}ms`);

  // Cleanup
  await supabase.from("checkpoint_dispatch_ledger").delete().eq("checkpoint_at", checkpointAt);
  await supabase.from("checkpoint_work_units").delete().eq("checkpoint_at", checkpointAt);
  await supabase.from("sync_runs").delete().eq("id", syncRunId);
}

runMultiInvocationTest().catch((err) => {
  console.error("TEST_ERROR:", err.message);
  process.exit(1);
});
