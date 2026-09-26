/**
 * Checkpoint Pipeline V2 - Staging Real Failure Injection & Telegram Quarantine Verification
 *
 * Tests executed against isolated Supabase staging database:
 * 1. Mid-batch worker crash: Worker claims 10 units, processes 3, halts ungracefully.
 *    Lease expires, Worker 2 claims remaining 7 units via SKIP LOCKED, completes them.
 * 2. Lease expiration reclaim: Worker 1 network freeze, lease expires, Worker 2 reclaims.
 * 3. Telegram quarantine verification: Worker 1 crashes post-reservation, retry detects
 *    AMBIGUOUS_STALE, moves to quarantine, zero duplicate external messages sent.
 */

import { createClient } from "@supabase/supabase-js";
import path from "path";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { CheckpointDispatchLedger, SupabaseDispatchLedgerStorage } from "../src/engine/checkpoint-v2/dispatch-ledger";
import { DEFAULT_WORKER_BUDGET } from "../src/domain/checkpoint-v2/types";

export interface FailureInjectionResults {
  midBatchCrash: {
    totalUnits: number;
    worker1Completed: number;
    worker2ClaimedAndCompleted: number;
    totalCompleted: number;
    droppedUnits: number;
    status: "PASS" | "FAIL";
  };
  leaseReclaim: {
    worker1Leased: boolean;
    leaseExpired: boolean;
    worker2Reclaimed: boolean;
    finalStatus: string;
    status: "PASS" | "FAIL";
  };
  telegramQuarantine: {
    reservationCreated: boolean;
    worker1CrashedBeforeConfirm: boolean;
    ambiguousStaleDetected: boolean;
    dispatchStatus: string;
    externalTelegramsSent: number;
    duplicateTelegramsSent: number;
    status: "PASS" | "FAIL";
  };
}

export async function runStagingFailureInjection(): Promise<FailureInjectionResults> {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  // Mandatory Production Safety Guard
  if (env.projectRef === "elwnbwimgzijuelfjdsq" || env.url.includes("elwnbwimgzijuelfjdsq")) {
    throw new Error("SAFETY_ABORT_PRODUCTION_TARGET: Attempted to run failure injection on production!");
  }

  const supabase = createClient(env.url, env.secretKey, {
    auth: { persistSession: false },
  });

  const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
  const ledgerStorage = new SupabaseDispatchLedgerStorage(supabase);
  const dispatchLedger = new CheckpointDispatchLedger(ledgerStorage, {
    lockTimeoutMs: 2_000,
    staleReservationPolicy: "QUARANTINE",
  });

  console.log("\n=======================================================");
  console.log("RUNNING STAGING REAL FAILURE INJECTION TESTS");
  console.log("Database Project:", env.projectRef);
  console.log("=======================================================\n");

  // Setup test sync run
  const checkpointAt = new Date().toISOString();
  const syncRunId = crypto.randomUUID();

  await supabase.from("sync_runs").insert({
    id: syncRunId,
    checkpoint_at: checkpointAt,
    status: "running",
    started_at: checkpointAt,
  });

  // Setup parent incident and followup case for dispatch tests
  const incId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const incidentKey = `WH_HNI_01:KHO_TON:FI_${syncRunId.slice(0, 8)}`;

  await supabase.from("incidents").insert({
    id: incId,
    incident_key: incidentKey,
    warehouse_id: "WH_HNI_01",
    warehouse_name: "Kho Hà Nội 01",
    reason_code: "KHO_TON",
    reason_name: "Tồn kho vượt định mức",
    status: "open",
    first_detected_at: checkpointAt,
    last_detected_at: checkpointAt,
    last_sync_run_id: syncRunId,
  });

  await supabase.from("followup_cases").insert({
    id: caseId,
    incident_id: incId,
    incident_key: incidentKey,
    current_state: "FOLLOWING_UP",
    first_detected_at: checkpointAt,
    last_checked_at: checkpointAt,
    created_at: checkpointAt,
    updated_at: checkpointAt,
  });

  const results: FailureInjectionResults = {
    midBatchCrash: {
      totalUnits: 10,
      worker1Completed: 0,
      worker2ClaimedAndCompleted: 0,
      totalCompleted: 0,
      droppedUnits: 0,
      status: "FAIL",
    },
    leaseReclaim: {
      worker1Leased: false,
      leaseExpired: false,
      worker2Reclaimed: false,
      finalStatus: "UNKNOWN",
      status: "FAIL",
    },
    telegramQuarantine: {
      reservationCreated: false,
      worker1CrashedBeforeConfirm: false,
      ambiguousStaleDetected: false,
      dispatchStatus: "UNKNOWN",
      externalTelegramsSent: 0,
      duplicateTelegramsSent: 0,
      status: "FAIL",
    },
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Mid-Batch Worker Crash & Lease Recovery
    // -------------------------------------------------------------------------
    console.log("TEST 1: Mid-Batch Worker Crash & Reclaim");
    const test1Units = [];
    for (let i = 0; i < 10; i++) {
      test1Units.push({
        checkpointAt,
        syncRunId,
        stage: "INGESTING" as const,
        workType: "INGEST_POPULATION_CHUNK" as const,
        partitionKey: `TEST1_CHUNK_${i}`,
        cursor: { offset: i * 10, limit: 10, total: 100 },
        idempotencyKey: `FI_TEST1:${syncRunId}:${i}`,
      });
    }
    await queueRepo.createWorkUnits(test1Units);

    // Worker 1 claims all 10 units
    const worker1Id = "worker-crash-simulation-1";
    const worker1Claimed = await queueRepo.claimWorkUnits(checkpointAt, worker1Id, 10, 10);
    console.log(`Worker 1 claimed ${worker1Claimed.length} units.`);

    // Worker 1 processes 3 units and completes them
    for (let i = 0; i < 3; i++) {
      await queueRepo.completeWorkUnit(worker1Claimed[i].id, worker1Id, { itemsProcessed: 10 });
    }
    results.midBatchCrash.worker1Completed = 3;
    console.log("Worker 1 completed 3 units, then crashes ungracefully (process dies)!");

    // Simulate lease expiration for the remaining 7 units
    const remainingIds = worker1Claimed.slice(3).map(u => u.id);
    const expiredTimestamp = new Date(Date.now() - 10_000).toISOString();
    await supabase
      .from("checkpoint_work_units")
      .update({ lease_expires_at: expiredTimestamp })
      .in("id", remainingIds);

    // Worker 2 comes online, claims units via SKIP LOCKED
    const worker2Id = "worker-recovery-2";
    const worker2Claimed = await queueRepo.claimWorkUnits(checkpointAt, worker2Id, 10, 10);
    console.log(`Worker 2 claimed ${worker2Claimed.length} expired units via SKIP LOCKED.`);
    results.midBatchCrash.worker2ClaimedAndCompleted = worker2Claimed.length;

    // Worker 2 completes all reclaimed units
    for (const unit of worker2Claimed) {
      await queueRepo.completeWorkUnit(unit.id, worker2Id, { itemsProcessed: 10 });
    }

    // Verify all 10 units completed
    const { count: completedCount } = await supabase
      .from("checkpoint_work_units")
      .select("*", { count: "exact", head: true })
      .eq("sync_run_id", syncRunId)
      .eq("status", "COMPLETED")
      .like("idempotency_key", `FI_TEST1:${syncRunId}:%`);

    results.midBatchCrash.totalCompleted = completedCount || 0;
    results.midBatchCrash.droppedUnits = 10 - (completedCount || 0);

    if (results.midBatchCrash.totalCompleted === 10 && results.midBatchCrash.worker2ClaimedAndCompleted === 7) {
      results.midBatchCrash.status = "PASS";
      console.log("TEST 1 RESULT: PASS (All 10 units completed, 0 work lost)\n");
    } else {
      console.error("TEST 1 RESULT: FAIL", results.midBatchCrash);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Lease Expiration Reclaim (Network Freeze Simulation)
    // -------------------------------------------------------------------------
    console.log("TEST 2: Lease Expiration Reclaim (Network Freeze)");
    const test2UnitKey = `FI_TEST2:${syncRunId}`;
    await queueRepo.createWorkUnits([{
      checkpointAt,
      syncRunId,
      stage: "FOLLOWUPS_PROCESSING" as const,
      workType: "PROCESS_FOLLOWUP_BATCH" as const,
      partitionKey: "TEST2_FREEZE",
      cursor: { offset: 0, limit: 5, total: 5 },
      idempotencyKey: test2UnitKey,
    }]);

    // Worker 1 claims with short lease (2 seconds)
    const freezeWorkerId = "worker-freeze-1";
    const claimedFreeze = await queueRepo.claimWorkUnits(checkpointAt, freezeWorkerId, 2, 1);
    results.leaseReclaim.worker1Leased = claimedFreeze.length === 1;
    console.log("Worker 1 acquired lease with 2-second timeout, then network freezes (no heartbeats).");

    // Wait 3 seconds for lease to expire
    await new Promise(r => setTimeout(r, 3_000));
    results.leaseReclaim.leaseExpired = true;

    // Worker 2 attempts claim
    const reclaimWorkerId = "worker-reclaim-2";
    const claimedReclaim = await queueRepo.claimWorkUnits(checkpointAt, reclaimWorkerId, 10, 1);
    results.leaseReclaim.worker2Reclaimed = claimedReclaim.length === 1 && claimedReclaim[0].idempotencyKey === test2UnitKey;

    if (results.leaseReclaim.worker2Reclaimed) {
      await queueRepo.completeWorkUnit(claimedReclaim[0].id, reclaimWorkerId, { itemsProcessed: 5 });
      const { data: finalUnit } = await supabase
        .from("checkpoint_work_units")
        .select("status")
        .eq("idempotency_key", test2UnitKey)
        .single();
      results.leaseReclaim.finalStatus = finalUnit?.status || "UNKNOWN";
    }

    if (results.leaseReclaim.worker1Leased && results.leaseReclaim.worker2Reclaimed && results.leaseReclaim.finalStatus === "COMPLETED") {
      results.leaseReclaim.status = "PASS";
      console.log("TEST 2 RESULT: PASS (Expired lease reclaimed via SKIP LOCKED and completed)\n");
    } else {
      console.error("TEST 2 RESULT: FAIL", results.leaseReclaim);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Telegram Quarantine Verification (Crash Post-Reservation)
    // -------------------------------------------------------------------------
    console.log("TEST 3: Telegram Quarantine Verification (Crash Post-Reservation)");
    let externalSendCount = 0;
    const sendExternalFake = async () => {
      externalSendCount++;
      return { telegramMessageId: `TG_MSG_QUARANTINE_TEST_${Date.now()}` };
    };

    const idempotencyKey = CheckpointDispatchLedger.buildIdempotencyKey(
      checkpointAt,
      caseId,
      "TELEGRAM_FIRST_PUSH",
      1
    );

    // Worker 1 reserves in ledger, then process crashes BEFORE sending or confirming
    const reserveRes = await ledgerStorage.reserve({
      checkpointAt,
      syncRunId,
      caseId,
      incidentKey,
      interventionType: "TELEGRAM_FIRST_PUSH",
      sequence: 1,
      idempotencyKey,
      status: "RESERVED",
    }, 2_000); // 2 second timeout

    results.telegramQuarantine.reservationCreated = reserveRes.status === "RESERVED_NEW";
    results.telegramQuarantine.worker1CrashedBeforeConfirm = true;
    console.log(`Worker 1 reserved dispatch row (status: ${reserveRes.status}), then crashes immediately!`);

    // Simulate time elapsed past lockTimeoutMs (2 seconds)
    const staleTime = new Date(Date.now() - 5_000).toISOString();
    await supabase
      .from("checkpoint_dispatch_ledger")
      .update({ reserved_at: staleTime })
      .eq("idempotency_key", idempotencyKey);

    // Worker 2 attempts dispatch retry on the same alert
    console.log("Worker 2 attempts dispatch retry on the same alert...");
    const retryRes = await dispatchLedger.dispatchEffectivelyOnce({
      checkpointAt,
      syncRunId,
      caseId,
      incidentKey,
      interventionType: "TELEGRAM_FIRST_PUSH",
      sequence: 1,
      sendExternal: sendExternalFake,
    });

    results.telegramQuarantine.dispatchStatus = retryRes.status;
    results.telegramQuarantine.ambiguousStaleDetected = retryRes.status === "QUARANTINED";
    results.telegramQuarantine.externalTelegramsSent = externalSendCount;
    results.telegramQuarantine.duplicateTelegramsSent = Math.max(0, externalSendCount - 1);

    // Verify row status in ledger
    const { data: ledgerRow } = await supabase
      .from("checkpoint_dispatch_ledger")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .single();

    console.log(`Ledger status after retry: ${ledgerRow?.status}, failure reason: ${ledgerRow?.failure_reason}`);
    console.log(`External Telegram send calls: ${externalSendCount}`);

    if (
      results.telegramQuarantine.reservationCreated &&
      results.telegramQuarantine.dispatchStatus === "QUARANTINED" &&
      results.telegramQuarantine.externalTelegramsSent === 0 &&
      results.telegramQuarantine.duplicateTelegramsSent === 0
    ) {
      results.telegramQuarantine.status = "PASS";
      console.log("TEST 3 RESULT: PASS (Stale reservation quarantined, 0 duplicate messages sent)\n");
    } else {
      console.error("TEST 3 RESULT: FAIL", results.telegramQuarantine);
    }

  } finally {
    // Clean up test data
    console.log("Cleaning up test data in staging...");
    await supabase.from("checkpoint_dispatch_ledger").delete().eq("sync_run_id", syncRunId);
    await supabase.from("checkpoint_work_units").delete().eq("sync_run_id", syncRunId);
    await supabase.from("followup_cases").delete().eq("id", caseId);
    await supabase.from("incidents").delete().eq("id", incId);
    await supabase.from("sync_runs").delete().eq("id", syncRunId);
    console.log("Cleanup complete.");
  }

  return results;
}

if (process.argv[1]?.includes("staging-failure-injection")) {
  runStagingFailureInjection()
    .then((results) => {
      console.log("FINAL FAILURE INJECTION RESULTS:", JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("FAILURE_INJECTION_ERROR:", err.message);
      process.exit(1);
    });
}
