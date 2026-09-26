import path from "path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { CheckpointShadowRunner } from "../src/engine/checkpoint-v2/checkpoint-shadow-runner";

async function runRealSchedulerTest() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  if (env.projectRef === "elwnbwimgzijuelfjdsq") {
    console.error("FATAL: Target is production database! Aborting immediately.");
    process.exit(1);
  }

  const supabase = createClient(env.url, env.secretKey, { auth: { persistSession: false } });
  const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
  const shadowRunner = new CheckpointShadowRunner(queueRepo);

  const pgClient = new pg.Client({
    host: "aws-0-ap-southeast-1.pooler.supabase.com",
    port: 6543,
    user: "postgres." + env.projectRef,
    password: env.dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();

  console.log("=== OPSPILOT V2 — REAL PG_CRON -> PG_NET -> HTTP WORKER TEST ===");
  console.log(`Target: Staging (${env.projectRef})`);

  // Clear telemetry on server
  try {
    await fetch("http://127.0.0.1:3005/admin/clear-telemetry", { method: "POST" });
  } catch (e: any) {
    console.warn("Could not clear telemetry:", e.message);
  }

  // 1. Seed synthetic SHADOW checkpoint via normal seed-only path
  const checkpointAt = new Date().toISOString();
  const syncRunId = crypto.randomUUID();

  // Create sync_run row first
  await supabase.from("sync_runs").upsert({
    id: syncRunId,
    checkpoint_at: checkpointAt,
    status: "running",
    started_at: checkpointAt,
  });

  console.log(`Seeding synthetic SHADOW checkpoint: checkpointAt=${checkpointAt}, syncRunId=${syncRunId}...`);
  const seedResult = await shadowRunner.seedShadowCheckpoint({
    checkpointAt,
    syncRunId,
    orderCount: 5000, // 5 work units (1000 orders each)
    incidentCount: 50,
  });
  console.log(`Seeded ${seedResult.unitsSeeded} SHADOW work units in ${seedResult.seedDurationMs}ms.`);

  // Verify units are in PENDING status
  const { count: pendingCount } = await supabase
    .from("checkpoint_work_units")
    .select("*", { count: "exact", head: true })
    .eq("checkpoint_at", checkpointAt)
    .eq("execution_mode", "SHADOW")
    .eq("status", "PENDING");
  console.log(`Confirmed in DB: ${pendingCount} PENDING units ready for pg_cron trigger.`);

  // Record initial state
  const testStartTime = new Date();
  console.log(`Waiting for real pg_cron scheduler (every minute: * * * * *)... (Started at ${testStartTime.toISOString()})`);
  console.log("DO NOT manually call the worker route.");

  let triggered = false;
  let cronRunDetails: any = null;
  let httpResponse: any = null;
  let workerRecord: any = null;

  const maxWaitSeconds = 120; // Up to 2 minutes
  const pollIntervalMs = 3000;
  const startWait = Date.now();

  while ((Date.now() - startWait) < maxWaitSeconds * 1000) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    // Check pg_cron job_run_details
    const cronRes = await pgClient.query(
      `SELECT * FROM cron.job_run_details 
       WHERE jobid = 3 AND start_time >= $1 
       ORDER BY start_time DESC LIMIT 1;`,
      [new Date(testStartTime.getTime() - 5000).toISOString()]
    );

    if (cronRes.rows.length > 0) {
      cronRunDetails = cronRes.rows[0];
      console.log(`[PG_CRON DETECTED] runid=${cronRunDetails.runid}, status=${cronRunDetails.status}, time=${cronRunDetails.start_time}`);
    }

    // Check net._http_response
    const netRes = await pgClient.query(
      `SELECT * FROM net._http_response 
       WHERE created >= $1 
       ORDER BY created DESC LIMIT 1;`,
      [new Date(testStartTime.getTime() - 5000).toISOString()]
    );

    if (netRes.rows.length > 0) {
      httpResponse = netRes.rows[0];
      console.log(`[PG_NET DETECTED] status_code=${httpResponse.status_code}, time=${httpResponse.created}`);
    }

    // Check server telemetry
    try {
      const telemRes = await fetch("http://127.0.0.1:3005/telemetry");
      if (telemRes.ok) {
        const telemData = await telemRes.json();
        const relevant = telemData.invocations?.find((inv: any) =>
          inv.checkpointAt === checkpointAt || inv.responseBody?.checkpointAt === checkpointAt
        );
        if (relevant) {
          workerRecord = relevant;
          console.log(`[WORKER HTTP INVOCATION DETECTED] ID=${workerRecord.invocationId}, duration=${workerRecord.durationMs}ms`);
        }
      }
    } catch {}

    // Check units status in DB
    const { count: completedCount } = await supabase
      .from("checkpoint_work_units")
      .select("*", { count: "exact", head: true })
      .eq("checkpoint_at", checkpointAt)
      .eq("execution_mode", "SHADOW")
      .eq("status", "COMPLETED");

    if (cronRunDetails && httpResponse && workerRecord && (completedCount || 0) > 0) {
      triggered = true;
      console.log(`SUCCESS: Real scheduler triggered worker. Completed units: ${completedCount}/${pendingCount}`);
      break;
    }
  }

  // Cleanup test run
  await supabase.from("checkpoint_dispatch_ledger").delete().eq("checkpoint_at", checkpointAt);
  await supabase.from("checkpoint_work_units").delete().eq("checkpoint_at", checkpointAt);
  await supabase.from("sync_runs").delete().eq("id", syncRunId);
  await pgClient.end();

  if (!triggered) {
    console.error("FAIL: Did not observe pg_cron -> pg_net -> HTTP worker trigger within timeout.");
    process.exit(1);
  }

  console.log("\n==================== SECTION 3 REPORT ====================");
  console.log(`CRON_RUN_TIMESTAMP: ${cronRunDetails.start_time}`);
  console.log(`CRON_STATUS: ${cronRunDetails.status}`);
  console.log(`PG_NET_HTTP_STATUS: ${httpResponse.status_code}`);
  console.log(`PG_NET_TIMED_OUT: ${httpResponse.timed_out}`);
  console.log(`WORKER_INVOCATION_ID: ${workerRecord.invocationId}`);
  console.log(`WORKER_UNITS_CLAIMED: ${workerRecord.workerSummary?.workUnitsClaimed}`);
  console.log(`WORKER_UNITS_COMPLETED: ${workerRecord.workerSummary?.workUnitsCompleted}`);
  console.log(`REAL_SCHEDULER_HTTP_TRIGGER: PASS`);
}

runRealSchedulerTest().catch((err) => {
  console.error("TEST_ERROR:", err.message);
  process.exit(1);
});
