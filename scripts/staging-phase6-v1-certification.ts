/**
 * Phase 6 Remote Staging Certification Suite for Durable V1 Hotfix
 * Target Staging DB: lxizjfrlecqqhkaeycmm
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { performance } from "perf_hooks";
import crypto from "crypto";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import {
  persistDurableV1Input,
  seedDurableV1Followups,
} from "../src/services/durable-v1-followup";
import {
  executeDurableV1CaseUnit,
  runDurableV1WorkerBatch,
} from "../src/services/durable-v1-worker";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import type { Incident } from "../src/engine/incident/types";
import type { NormalizedRillnetOrder } from "../src/connectors/rillnet/types";

function makeOrders(count: number, prefix: string, warehouseId: string, checkpointAt: string): NormalizedRillnetOrder[] {
  const refTime = Date.parse(checkpointAt);
  return Array.from({ length: count }, (_, i) => ({
    orderCode: `ORD_${prefix}_${String(i).padStart(4, "0")}`,
    customerId: `CUST_${prefix}`,
    warehouseId,
    warehouseName: `Kho ${warehouseId}`,
    status: "picking",
    sourceStatus: "PICKING",
    orderCreatedAt: new Date(refTime - 48 * 3600 * 1000).toISOString(),
    sourceUpdatedAt: checkpointAt,
    fetchedAt: checkpointAt,
    ageHours: 48,
    warehouseType: "KHO_TON",
  } as any));
}

function makeIncidents(count: number, prefix: string, checkpointAt: string): { incidents: Incident[]; orders: NormalizedRillnetOrder[] } {
  const allOrders: NormalizedRillnetOrder[] = [];
  const incidents: Incident[] = [];

  for (let i = 0; i < count; i++) {
    const warehouseId = `WH_${prefix}_${i % 5}`;
    const orders = makeOrders(4, `${prefix}_${i}`, warehouseId, checkpointAt);
    allOrders.push(...orders);
    const orderCodes = orders.map(o => o.orderCode);
    const incidentKey = `CERT_${prefix}_${String(i).padStart(4, "0")}`;

    incidents.push({
      incidentId: crypto.randomUUID(),
      incidentKey,
      warehouseId,
      warehouseName: `Kho ${warehouseId}`,
      reasonCode: "KHO_TON" as any,
      reasonName: "Kho tồn lâu",
      status: "open",
      priorityScore: 50,
      firstDetectedAt: checkpointAt,
      lastDetectedAt: checkpointAt,
      affectedOrderCount: orderCodes.length,
      affectedOrders: orderCodes,
      sampleOrderCodes: orderCodes.slice(0, 3),
      averageAgeHours: 48,
      maximumAgeHours: 52,
      oldestOrderCode: orderCodes[0] || null,
    });
  }
  return { incidents, orders: allOrders };
}

async function persistIncidentsToTable(client: SupabaseClient, incidents: Incident[], syncRunId: string) {
  const rows = incidents.map(inc => ({
    id: inc.incidentId,
    incident_key: inc.incidentKey,
    warehouse_id: inc.warehouseId,
    warehouse_name: inc.warehouseName,
    reason_code: inc.reasonCode,
    reason_name: inc.reasonName,
    status: inc.status,
    priority_score: inc.priorityScore,
    first_detected_at: inc.firstDetectedAt,
    last_detected_at: inc.lastDetectedAt,
    last_sync_run_id: syncRunId,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await client.from("incidents").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
  }
}

async function runCertification() {
  console.log("=== PHASE 6: DURABLE V1 REMOTE STAGING CERTIFICATION ===");
  const env = loadAndVerifyStagingEnv(".env.staging.local");

  let fetchCount = 0;
  let logFetches = false;
  const rawClient = createClient(env.url, env.secretKey, {
    auth: { persistSession: false },
    global: {
      fetch: (...args: any[]) => {
        fetchCount++;
        const url = String(args[0]);
        const path = url.split("/rest/v1/")[1] || url;
        if (logFetches) console.log(`  [FETCH ${fetchCount}] ${path.split("?")[0]}`);
        return fetch(...(args as [any, any]));
      },
    },
  });

  const queue = new SupabaseCheckpointWorkQueueRepository(rawClient);

  // Distinct future test dates (all 08:00 ICT = 01:00 UTC baselines)
  const randomBaseDay = 1 + Math.floor(Math.random() * 500);
  const testDates = Array.from({ length: 10 }, (_, i) =>
    new Date(Date.UTC(2027, 0, randomBaseDay + i, 1, 0, 0, 0)).toISOString()
  );

  // Clean test fixtures on staging
  await rawClient.from("sync_runs").delete().in("checkpoint_at", testDates);
  await rawClient.from("sync_runs").update({ status: "failed", error_code: "STALE_CLEANUP" }).eq("status", "running");
  await rawClient.from("checkpoint_work_units").update({ status: "FAILED" }).in("status", ["PENDING", "LEASED"]);
  await rawClient.from("followup_cases").update({ current_state: "CLOSED" }).neq("current_state", "CLOSED");

  const results: Record<string, { pass: boolean; details: any }> = {};

  // --------------------------------------------------------------------------
  // TEST A: 25-Case Unit Performance, DB Round Trips (<= 10) & Semantic Parity
  // --------------------------------------------------------------------------
  console.log("\n--- TEST A: 25-Case Unit Round Trips & Performance ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[0];
    const prefix = `TESTA_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(25, prefix, checkpointAt);

    const { error: insErr } = await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });
    if (insErr) throw insErr;

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    await persistDurableV1Input(rawClient, {
      checkpointAt,
      syncRunId,
      referenceTimeMs: Date.parse(checkpointAt),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunId);

    const seedRes = await seedDurableV1Followups(rawClient, checkpointAt, syncRunId, { orders });
    console.log(`Seeded Test A: candidates=${seedRes.candidateCount}, units=${seedRes.workUnits}`);

    const units = await queue.claimWorkUnits(checkpointAt, "cert_worker_a", 65000, 1, "PRODUCTION", "V1");
    if (units.length !== 1) throw new Error(`TEST_A: Expected 1 unit claimed, got ${units.length}`);
    const unit = units[0];

    logFetches = true;
    fetchCount = 0;
    const t0 = performance.now();
    const execRes = await executeDurableV1CaseUnit(rawClient, unit, "cert_worker_a");
    const durationMs = performance.now() - t0;
    const dbRoundTrips = fetchCount;
    logFetches = false;
    await queue.completeWorkUnit(unit.id, "cert_worker_a");
    await rawClient.from("sync_runs").update({ status: "success", completed_at: new Date().toISOString() }).eq("id", syncRunId);

    const keys = incidents.map(i => i.incidentKey);
    const { data: persistedCases } = await rawClient.from("followup_cases").select("id, incident_key").in("incident_key", keys);
    const caseIds = (persistedCases || []).map(c => c.id);
    const { count: archiveCount } = await rawClient.from("followup_case_cohort_archive")
      .select("followup_case_id", { count: "exact", head: true })
      .in("followup_case_id", caseIds);

    const caseCount = persistedCases?.length || 0;
    const passRoundTrips = dbRoundTrips <= 10;
    const passDuration = durationMs < 45000;
    const passParity = caseCount === 25 && archiveCount === 25;
    const pass = passRoundTrips && passDuration && passParity;

    results["TEST_A_25_CASE_UNIT"] = {
      pass,
      details: {
        durationMs: Math.round(durationMs),
        dbRoundTrips,
        passRoundTrips,
        passDuration,
        caseCount,
        archiveCount,
        passParity,
      },
    };
    console.log(`TEST A RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  Duration: ${Math.round(durationMs)}ms (Gate: <45,000ms, Target: <15,000ms)`);
    console.log(`  DB Round Trips: ${dbRoundTrips} (Gate: <= 10 calls, was 58 before hotfix)`);
    console.log(`  Cases Persisted: ${caseCount}/25, Cohort Archive: ${archiveCount}/25`);
  }

  // --------------------------------------------------------------------------
  // TEST B: Small Unit (3 cases) Edge Case
  // --------------------------------------------------------------------------
  console.log("\n--- TEST B: Small Unit (3 cases) ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[1];
    const prefix = `TESTB_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(3, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    await persistDurableV1Input(rawClient, {
      checkpointAt,
      syncRunId,
      referenceTimeMs: Date.parse(checkpointAt),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunId);

    const seedRes = await seedDurableV1Followups(rawClient, checkpointAt, syncRunId, { orders });
    const units = await queue.claimWorkUnits(checkpointAt, "cert_worker_b", 65000, 1, "PRODUCTION", "V1");
    if (units.length !== 1) throw new Error(`TEST_B: Expected 1 unit claimed, got ${units.length}`);

    const t0 = performance.now();
    const execRes = await executeDurableV1CaseUnit(rawClient, units[0], "cert_worker_b");
    const durationMs = performance.now() - t0;
    await queue.completeWorkUnit(units[0].id, "cert_worker_b");
    await rawClient.from("sync_runs").update({ status: "success", completed_at: new Date().toISOString() }).eq("id", syncRunId);

    const pass = execRes.itemsProcessed === 3 && seedRes.workUnits === 1;
    results["TEST_B_SMALL_UNIT"] = {
      pass,
      details: { itemsProcessed: execRes.itemsProcessed, durationMs: Math.round(durationMs) },
    };
    console.log(`TEST B RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  Items processed: ${execRes.itemsProcessed}/3, Duration: ${Math.round(durationMs)}ms`);
  }

  // --------------------------------------------------------------------------
  // TEST C: 540 Candidates / 22 Units Full Drain & Finalizer Seeding
  // --------------------------------------------------------------------------
  console.log("\n--- TEST C: 540 Candidates / 22 Units Full Drain ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[2];
    const prefix = `TESTC_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(540, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    await persistDurableV1Input(rawClient, {
      checkpointAt,
      syncRunId,
      referenceTimeMs: Date.parse(checkpointAt),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunId);

    const seedRes = await seedDurableV1Followups(rawClient, checkpointAt, syncRunId, { orders });
    console.log(`Seeded Test C: candidates=${seedRes.candidateCount}, units=${seedRes.workUnits} (expected 22)`);

    // Drain all 22 units
    let drainedUnits = 0;
    const t0 = performance.now();
    for (let i = 0; i < 22; i++) {
      const claimed = await queue.claimWorkUnits(checkpointAt, `cert_worker_c_${i}`, 65000, 1, "PRODUCTION", "V1");
      if (claimed.length === 0) break;
      await executeDurableV1CaseUnit(rawClient, claimed[0], `cert_worker_c_${i}`);
      await queue.completeWorkUnit(claimed[0].id, `cert_worker_c_${i}`);
      drainedUnits++;
    }
    const drainDurationMs = performance.now() - t0;

    await runDurableV1WorkerBatch(rawClient, checkpointAt, syncRunId);

    const { data: finalizerUnit } = await rawClient.from("checkpoint_work_units")
      .select("id, status, work_type")
      .eq("sync_run_id", syncRunId)
      .eq("work_type", "FINALIZE_V1_CHECKPOINT")
      .maybeSingle();

    // Complete finalizer unit and sync run for Test C so it doesn't leave an unfinalized running checkpoint
    if (finalizerUnit) {
      await rawClient.from("checkpoint_work_units").update({ status: "COMPLETED", completed_at: new Date().toISOString() }).eq("id", finalizerUnit.id);
      await rawClient.from("sync_runs").update({ status: "success", completed_at: new Date().toISOString() }).eq("id", syncRunId);
    }

    const pass = seedRes.workUnits === 22 && drainedUnits === 22 && finalizerUnit !== null;
    results["TEST_C_540_CANDIDATES_22_UNITS"] = {
      pass,
      details: {
        candidateCount: seedRes.candidateCount,
        workUnits: seedRes.workUnits,
        drainedUnits,
        totalDrainDurationMs: Math.round(drainDurationMs),
        avgUnitMs: Math.round(drainDurationMs / 22),
        finalizerSeeded: finalizerUnit !== null,
        finalizerStatus: finalizerUnit?.status,
      },
    };
    console.log(`TEST C RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  Units Seeded: ${seedRes.workUnits}, Drained: ${drainedUnits}/22`);
    console.log(`  Total Drain Duration: ${Math.round(drainDurationMs)}ms (avg ${Math.round(drainDurationMs / 22)}ms/unit)`);
    console.log(`  Finalizer Seeded: ${finalizerUnit ? "YES (" + finalizerUnit.status + ")" : "NO"}`);
  }

  // --------------------------------------------------------------------------
  // TEST D: Dead-Letter Exhaustion (Attempts = 3 -> FAILED -> Sync Run Failed -> IDLE)
  // --------------------------------------------------------------------------
  console.log("\n--- TEST D: Dead-Letter Exhaustion & Finalizer Failure ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[3];
    const prefix = `TESTD_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(25, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    await persistDurableV1Input(rawClient, {
      checkpointAt,
      syncRunId,
      referenceTimeMs: Date.parse(checkpointAt),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunId);

    await seedDurableV1Followups(rawClient, checkpointAt, syncRunId, { orders });

    const { data: unitsToExhaust } = await rawClient.from("checkpoint_work_units")
      .select("id")
      .eq("sync_run_id", syncRunId);

    if (!unitsToExhaust?.length) throw new Error("TEST_D: No work units found");
    const unitToExhaust = unitsToExhaust[0];

    const expiredTimestamp = new Date(Date.now() - 10000).toISOString();
    await rawClient.from("checkpoint_work_units").update({
      status: "LEASED",
      lease_owner: "simulated_dead_worker",
      lease_expires_at: expiredTimestamp,
      attempts: 3,
      max_attempts: 3,
      last_safe_error: "Vercel function timed out after 60s",
    }).eq("id", unitToExhaust.id);

    // Call get_next_actionable_v1_checkpoint RPC: triggers atomic sweep to status = 'FAILED'
    await rawClient.rpc("get_next_actionable_v1_checkpoint", {
      p_execution_mode: "PRODUCTION",
    });

    const { data: updatedUnit } = await rawClient.from("checkpoint_work_units")
      .select("status, failure_code, last_safe_error")
      .eq("id", unitToExhaust.id)
      .single();

    // Run worker batch: seedFinalizerIfDrained marks sync_run as failed
    await runDurableV1WorkerBatch(rawClient, checkpointAt, syncRunId);

    const { data: updatedSyncRun } = await rawClient.from("sync_runs")
      .select("status, error_code, error_message")
      .eq("id", syncRunId)
      .single();

    // Subsequent call must NOT return this sync run
    const { data: nextActionable } = await rawClient.rpc("get_next_actionable_v1_checkpoint", {
      p_execution_mode: "PRODUCTION",
    });
    const stillReturned = nextActionable?.some((r: any) => r.sync_run_id === syncRunId) ?? false;

    const unitFailed = updatedUnit?.status === "FAILED";
    const syncRunFailed = updatedSyncRun?.status === "failed" && updatedSyncRun?.error_code === "V1_WORK_UNIT_ATTEMPTS_EXHAUSTED";
    const yieldsIdle = !stillReturned;
    const pass = unitFailed && syncRunFailed && yieldsIdle;

    results["TEST_D_DEAD_LETTER_EXHAUSTION"] = {
      pass,
      details: {
        unitStatus: updatedUnit?.status,
        unitFailureCode: updatedUnit?.failure_code,
        syncRunStatus: updatedSyncRun?.status,
        syncRunErrorCode: updatedSyncRun?.error_code,
        yieldsIdle,
      },
    };
    console.log(`TEST D RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  Unit Status: ${updatedUnit?.status} (Expected: FAILED)`);
    console.log(`  Sync Run Status: ${updatedSyncRun?.status}, Error: ${updatedSyncRun?.error_code} (Expected: failed / V1_WORK_UNIT_ATTEMPTS_EXHAUSTED)`);
    console.log(`  Yields Idle on subsequent calls: ${yieldsIdle ? "YES" : "NO"}`);
  }

  // --------------------------------------------------------------------------
  // TEST E: No Starvation Across Checkpoints
  // --------------------------------------------------------------------------
  console.log("\n--- TEST E: No Starvation Across Checkpoints ---");
  {
    // Sync Run D is already failed.
    // Create Checkpoint B (newer, running sync run with 1 unit).
    const syncRunB = crypto.randomUUID();
    const checkpointAtB = testDates[4];
    const prefix = `TESTE_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(25, prefix, checkpointAtB);

    await rawClient.from("sync_runs").insert({
      id: syncRunB,
      checkpoint_at: checkpointAtB,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunB);

    await persistDurableV1Input(rawClient, {
      checkpointAt: checkpointAtB,
      syncRunId: syncRunB,
      referenceTimeMs: Date.parse(checkpointAtB),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunB);

    await seedDurableV1Followups(rawClient, checkpointAtB, syncRunB, { orders });

    // Call get_next_actionable_v1_checkpoint: MUST return Checkpoint B immediately!
    const { data: actionable } = await rawClient.rpc("get_next_actionable_v1_checkpoint", {
      p_execution_mode: "PRODUCTION",
    });

    const pickedCheckpoint = actionable?.[0];
    const pickedB = pickedCheckpoint?.sync_run_id === syncRunB;

    const claimed = await queue.claimWorkUnits(checkpointAtB, "cert_worker_e", 65000, 1, "PRODUCTION", "V1");
    let drainedB = false;
    if (claimed.length === 1) {
      await executeDurableV1CaseUnit(rawClient, claimed[0], "cert_worker_e");
      await queue.completeWorkUnit(claimed[0].id, "cert_worker_e");
      drainedB = true;
    }

    const pass = pickedB && drainedB;
    results["TEST_E_NO_STARVATION"] = {
      pass,
      details: {
        pickedCheckpoint: pickedCheckpoint?.sync_run_id,
        expectedB: syncRunB,
        drainedB,
      },
    };
    console.log(`TEST E RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  RPC returned Checkpoint B immediately: ${pickedB ? "YES" : "NO"}`);
    console.log(`  Checkpoint B unit claimed and completed: ${drainedB ? "YES" : "NO"}`);
  }

  // --------------------------------------------------------------------------
  // TEST F: Idempotency & Zero Duplicates
  // --------------------------------------------------------------------------
  console.log("\n--- TEST F: Idempotency & Zero Duplicates ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[5];
    const prefix = `TESTF_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(25, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    await persistDurableV1Input(rawClient, {
      checkpointAt,
      syncRunId,
      referenceTimeMs: Date.parse(checkpointAt),
      orders,
      incidents,
    });

    await rawClient.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: incidents.map(i => i.incidentKey) })
      .eq("sync_run_id", syncRunId);

    await seedDurableV1Followups(rawClient, checkpointAt, syncRunId, { orders });

    const units = await queue.claimWorkUnits(checkpointAt, "cert_worker_f", 65000, 1, "PRODUCTION", "V1");
    const unit = units[0];

    // First execution
    await executeDurableV1CaseUnit(rawClient, unit, "cert_worker_f");

    const keys = incidents.map(i => i.incidentKey);
    const { count: cases1 } = await rawClient.from("followup_cases").select("id", { count: "exact", head: true }).in("incident_key", keys);
    const { data: persistedCases } = await rawClient.from("followup_cases").select("id").in("incident_key", keys);
    const caseIds = (persistedCases || []).map(c => c.id);
    const { count: archive1 } = await rawClient.from("followup_case_cohort_archive").select("followup_case_id", { count: "exact", head: true }).in("followup_case_id", caseIds);

    // Second execution (re-play simulation of exact same unit)
    await executeDurableV1CaseUnit(rawClient, unit, "cert_worker_f");

    const { count: cases2 } = await rawClient.from("followup_cases").select("id", { count: "exact", head: true }).in("incident_key", keys);
    const { count: archive2 } = await rawClient.from("followup_case_cohort_archive").select("followup_case_id", { count: "exact", head: true }).in("followup_case_id", caseIds);

    await queue.completeWorkUnit(unit.id, "cert_worker_f");

    const pass = cases1 === 25 && cases2 === 25 && archive1 === 25 && archive2 === 25;
    results["TEST_F_IDEMPOTENCY_ZERO_DUPLICATES"] = {
      pass,
      details: {
        casesRun1: cases1,
        casesRun2: cases2,
        archiveRun1: archive1,
        archiveRun2: archive2,
      },
    };
    console.log(`TEST F RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  Cases Run 1: ${cases1}, Cases Run 2: ${cases2} (Diff: ${(cases2 || 0) - (cases1 || 0)})`);
    console.log(`  Cohort Archive Run 1: ${archive1}, Cohort Archive Run 2: ${archive2} (Diff: ${(archive2 || 0) - (archive1 || 0)})`);
  }

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log("\n================ CERTIFICATION SUMMARY ================");
  let allPass = true;
  for (const [name, res] of Object.entries(results)) {
    console.log(`${name}: ${res.pass ? "PASS" : "FAIL"}`);
    if (!res.pass) allPass = false;
  }
  console.log(`OVERALL CERTIFICATION: ${allPass ? "PASS" : "FAIL"}`);
  console.log("=======================================================\n");

  return { allPass, results };
}

runCertification().then(({ allPass }) => {
  if (!allPass) process.exit(1);
}).catch(err => {
  console.error("CERTIFICATION CRASHED:", err);
  process.exit(1);
});
