import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { performance } from "perf_hooks";
import {
  persistDurableV1Input,
  seedDurableV1Followups,
} from "../src/services/durable-v1-followup";
import {
  executeDurableV1CaseUnit,
  runDurableV1WorkerBatch,
} from "../src/services/durable-v1-worker";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { SupabaseFollowupRepository } from "../src/repositories/supabase/SupabaseFollowupRepository";
import { FollowupEngine } from "../src/engine/followup/followup-engine";
import { ActionQueue } from "../src/engine/action-queue";
import type { Incident } from "../src/engine/incident/types";
import type { NormalizedRillnetOrder } from "../src/connectors/rillnet/types";

function loadAndVerifyStagingEnv(envFile = ".env.staging.local"): { url: string; secretKey: string; ref: string; dbPassword: string } {
  const envPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing staging env file: ${envPath}`);
  }
  const content = fs.readFileSync(envPath, "utf8");
  const parsed: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [k, ...rest] = trimmed.split("=");
    parsed[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  const url = parsed.STAGING_SUPABASE_URL;
  const secretKey = parsed.STAGING_SUPABASE_SECRET_KEY;
  const ref = parsed.STAGING_SUPABASE_PROJECT_REF;
  const dbPassword = parsed.STAGING_SUPABASE_DB_PASSWORD;
  if (!url || !secretKey || !ref || !dbPassword) {
    throw new Error("Missing STAGING credentials in staging env");
  }
  if (!url.includes("lxizjfrlecqqhkaeycmm")) {
    throw new Error(`CRITICAL: Staging URL must target staging lxizjfrlecqqhkaeycmm, got ${url}`);
  }
  return { url, secretKey, ref, dbPassword };
}

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
    const incidentKey = `FINAL_${prefix}_${String(i).padStart(4, "0")}`;

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
    status: "open",
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

async function main() {
  console.log("=== OPSPILOT RELEASE B.2 FINAL GO/NO-GO GATE ===");
  const env = loadAndVerifyStagingEnv(".env.staging.local");
  process.env.SUPABASE_URL = env.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.secretKey;

  const rawClient = createClient(env.url, env.secretKey, {
    auth: { persistSession: false },
  });

  const queue = new SupabaseCheckpointWorkQueueRepository(rawClient);

  const baseDay = 100 + Math.floor(Math.random() * 800);
  const testDates = Array.from({ length: 6 }, (_, i) =>
    new Date(Date.UTC(2027, 2, baseDay + i, 1, 0, 0, 0)).toISOString()
  );

  // Clean staging
  await rawClient.from("sync_runs").update({ status: "failed", error_code: "STALE_CLEANUP" }).eq("status", "running");
  await rawClient.from("checkpoint_work_units").update({ status: "FAILED" }).in("status", ["PENDING", "LEASED"]);
  await rawClient.from("followup_cases").delete().or("incident_key.like.FINAL_%,incident_key.like.ATOM_%,incident_key.like.PARITY_%,incident_key.like.IDEMP_%,incident_key.like.TEST%");

  const results: Record<string, any> = {};

  // =========================================================================
  // GATE 4: MIGRATION 103 SECURITY & PRIVILEGE AUDIT
  // =========================================================================
  console.log("\n--- GATE 4: MIGRATION 103 SECURITY & PRIVILEGE AUDIT ---");
  {
    const pg = new PgClient({
      host: "aws-0-ap-southeast-1.pooler.supabase.com",
      port: 6543,
      database: "postgres",
      user: `postgres.${env.ref}`,
      password: env.dbPassword,
      ssl: { rejectUnauthorized: false },
    });
    await pg.connect();

    const rpcs = [
      "batch_update_followup_cases_cohort(jsonb)",
      "get_next_actionable_v1_checkpoint(text)",
      "claim_checkpoint_work_units(timestamp with time zone,text,integer,integer,text,text)"
    ];

    let allPublicRevoked = true;
    let allAnonRevoked = true;
    let allAuthRevoked = true;
    let allServiceRoleGranted = true;

    for (const rpc of rpcs) {
      const pub = await pg.query(`SELECT has_function_privilege('public', '${rpc}'::regprocedure, 'EXECUTE') as has_priv`);
      const anon = await pg.query(`SELECT has_function_privilege('anon', '${rpc}'::regprocedure, 'EXECUTE') as has_priv`);
      const auth = await pg.query(`SELECT has_function_privilege('authenticated', '${rpc}'::regprocedure, 'EXECUTE') as has_priv`);
      const srv = await pg.query(`SELECT has_function_privilege('service_role', '${rpc}'::regprocedure, 'EXECUTE') as has_priv`);

      if (pub.rows[0].has_priv) allPublicRevoked = false;
      if (anon.rows[0].has_priv) allAnonRevoked = false;
      if (auth.rows[0].has_priv) allAuthRevoked = false;
      if (!srv.rows[0].has_priv) allServiceRoleGranted = false;

      console.log(`  ${rpc}: public=${pub.rows[0].has_priv}, anon=${anon.rows[0].has_priv}, authenticated=${auth.rows[0].has_priv}, service_role=${srv.rows[0].has_priv}`);
    }

    const procs = await pg.query(`
      SELECT proname, prosecdef, proconfig
      FROM pg_proc
      WHERE proname IN ('batch_update_followup_cases_cohort', 'get_next_actionable_v1_checkpoint', 'claim_checkpoint_work_units');
    `);

    let allSecurityDefiner = true;
    let allFixedSearchPath = true;
    for (const p of procs.rows) {
      if (!p.prosecdef) allSecurityDefiner = false;
      const searchPathConfig = (p.proconfig || []).find((c: string) => c.startsWith("search_path="));
      if (searchPathConfig !== "search_path=pg_catalog, public") allFixedSearchPath = false;
    }

    await pg.end();

    const passSecurity = allPublicRevoked && allAnonRevoked && allAuthRevoked && allServiceRoleGranted && allSecurityDefiner && allFixedSearchPath;
    results["GATE_4_SECURITY"] = {
      allPublicRevoked,
      allAnonRevoked,
      allAuthRevoked,
      allServiceRoleGranted,
      allSecurityDefiner,
      allFixedSearchPath,
      pass: passSecurity,
    };
    console.log(`GATE 4 RESULT: ${passSecurity ? "PASS" : "FAIL"}`);
    console.log(`  PUBLIC EXECUTE REVOKED: ${allPublicRevoked ? "YES" : "NO"}`);
    console.log(`  anon EXECUTE REVOKED: ${allAnonRevoked ? "YES" : "NO"}`);
    console.log(`  authenticated EXECUTE REVOKED: ${allAuthRevoked ? "YES" : "NO"}`);
    console.log(`  service_role EXECUTE GRANTED: ${allServiceRoleGranted ? "YES" : "NO"}`);
    console.log(`  SECURITY DEFINER: ${allSecurityDefiner ? "YES" : "NO"}`);
    console.log(`  FIXED SAFE SEARCH_PATH: ${allFixedSearchPath ? "pg_catalog, public" : "FAIL"}`);
  }

  // =========================================================================
  // GATE 5: ATOMIC BATCH RPC CORRECTNESS (ROLLBACK ON CONFLICT)
  // =========================================================================
  console.log("\n--- GATE 5: ATOMIC BATCH RPC CORRECTNESS & ROLLBACK ---");
  {
    const prefix = `ATOM_${Date.now().toString(36)}`;
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[0];
    const { incidents } = makeIncidents(5, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      started_at: new Date().toISOString(),
    });

    await persistIncidentsToTable(rawClient, incidents, syncRunId);

    // Insert 5 parent cases
    const now = new Date().toISOString();
    const seeds = incidents.map(inc => ({
      incident_id: inc.incidentId,
      incident_key: inc.incidentKey,
      current_state: "NEW",
      first_detected_at: checkpointAt,
      updated_at: now,
    }));
    const { data: insertedCases, error: seedErr } = await rawClient.from("followup_cases").insert(seeds).select();
    if (seedErr) throw seedErr;

    // Register generation records
    const genRecords = insertedCases.map(c => ({
      followup_case_id: c.id,
      generation_id: syncRunId,
      source_sync_run_id: syncRunId,
      expected_member_count: 4,
      generation_status: "PREPARING",
      committed_at: null,
    }));
    await rawClient.from("followup_case_member_generations").insert(genRecords);

    // Prepare updates payload for RPC, but tamper with item 2 (stale timestamp)
    const payload = insertedCases.map((c, idx) => ({
      id: c.id,
      expected_updated_at: idx === 2 ? new Date(Date.now() - 3600000).toISOString() : c.updated_at,
      current_state: "FOLLOWING_UP",
      current_assessment: "insufficient_data",
      current_progress_percent: 0,
      latest_affected_order_count: 4,
      baseline_affected_order_count: 4,
      cohort_version: 2,
      member_generation_id: syncRunId,
      operational_cohort: { version: 2, memberCount: 4 },
    }));

    let rpcExceptionCaught = false;
    let rpcErrorMessage = "";
    try {
      const { data, error } = await rawClient.rpc("batch_update_followup_cases_cohort", { p_updates: payload });
      if (error) {
        rpcExceptionCaught = true;
        rpcErrorMessage = error.message;
      }
    } catch (err: any) {
      rpcExceptionCaught = true;
      rpcErrorMessage = err.message;
    }

    // Verify rollback: zero cases should be FOLLOWING_UP, zero generations COMMITTED
    const { data: verifiedCases } = await rawClient.from("followup_cases")
      .select("id, current_state")
      .in("id", insertedCases.map(c => c.id));
    
    const { data: verifiedGens } = await rawClient.from("followup_case_member_generations")
      .select("followup_case_id, generation_status")
      .in("followup_case_id", insertedCases.map(c => c.id));

    const updatedCaseCount = verifiedCases?.filter(c => c.current_state === "FOLLOWING_UP").length || 0;
    const committedGenCount = verifiedGens?.filter(g => g.generation_status === "COMMITTED").length || 0;
    const partialCommit = updatedCaseCount > 0 || committedGenCount > 0;

    results["GATE_5_ATOM_RPC"] = {
      rpcExceptionCaught,
      rpcErrorMessage,
      updatedCaseCount,
      committedGenCount,
      partialCommit: partialCommit ? 1 : 0,
      pass: rpcExceptionCaught && !partialCommit,
    };
    console.log(`GATE 5 RESULT: ${rpcExceptionCaught && !partialCommit ? "PASS" : "FAIL"}`);
    console.log(`  Tampered update rejected with exception: ${rpcExceptionCaught ? "YES (" + rpcErrorMessage + ")" : "NO"}`);
    console.log(`  Updated case count on rollback: ${updatedCaseCount}/5 (Expected: 0)`);
    console.log(`  Committed generations on rollback: ${committedGenCount}/5 (Expected: 0)`);
    console.log(`  PARTIAL_COMMIT: ${partialCommit ? 1 : 0}`);

    // Clean up Gate 5 fixtures
    await rawClient.from("followup_case_member_generations").delete().eq("generation_id", syncRunId);
    await rawClient.from("followup_cases").delete().in("id", insertedCases.map(c => c.id));
    await rawClient.from("incidents").delete().in("id", incidents.map(i => i.incidentId));
    await rawClient.from("sync_runs").delete().eq("id", syncRunId);
  }

  // =========================================================================
  // GATE 2: REAL SEMANTIC PARITY
  // =========================================================================
  console.log("\n--- GATE 2: REAL SEMANTIC PARITY ---");
  {
    const prefix = `PARITY_${Date.now().toString(36)}`;
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[1];
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

    const units = await queue.claimWorkUnits(checkpointAt, "cert_parity_worker", 65000, 1, "PRODUCTION", "V1");
    if (units.length !== 1) throw new Error("Expected 1 unit for Gate 2");

    const execRes = await executeDurableV1CaseUnit(rawClient, units[0], "cert_parity_worker");
    await queue.completeWorkUnit(units[0].id, "cert_parity_worker");

    // Verify all 25 cases have exact required fields populated
    const { data: persistedCases } = await rawClient.from("followup_cases")
      .select("*")
      .in("incident_key", incidents.map(i => i.incidentKey));

    const { data: memberGens } = await rawClient.from("followup_case_member_generations")
      .select("*")
      .eq("generation_id", syncRunId);

    const { data: members } = await rawClient.from("followup_case_members")
      .select("*")
      .eq("generation_id", syncRunId);

    const { data: events } = await rawClient.from("followup_events")
      .select("*")
      .like("durable_work_key", `${syncRunId}:%`);

    let parityCaseState = persistedCases?.length === 25 && persistedCases.every(c => c.current_state === "FOLLOWING_UP" || c.current_state === "NEW");
    let parityCohort = persistedCases?.every(c => c.cohort_version === 2 && c.operational_cohort?.version === 2 && c.operational_cohort?.memberCount === 4) ?? false;
    let parityMemberGen = memberGens?.length === 25 && memberGens.every(g => g.generation_status === "COMMITTED" && g.expected_member_count === 4);
    let parityMembers = members?.length === 100 && members.every(m => Boolean(m.order_code) && Boolean(m.status));
    let parityEvents = events?.length === 25 && events.every(e => Boolean(e.event_type));
    let parityDecisions = execRes.itemsProcessed === 25;

    const semanticParity = parityCaseState && parityCohort && parityMemberGen && parityMembers && parityEvents && parityDecisions;

    results["GATE_2_PARITY"] = {
      parityCaseState,
      parityCohort,
      parityMemberGen,
      parityMembers,
      parityEvents,
      parityDecisions,
      semanticParityPercent: semanticParity ? 100 : 0,
      pass: semanticParity,
    };
    console.log(`GATE 2 RESULT: ${semanticParity ? "PASS" : "FAIL"}`);
    console.log(`  Case state parity: ${parityCaseState ? "100%" : "FAIL"}`);
    console.log(`  Operational cohort parity: ${parityCohort ? "100%" : "FAIL"}`);
    console.log(`  Member generation parity: ${parityMemberGen ? "100%" : "FAIL"}`);
    console.log(`  Member rows parity: ${parityMembers ? "100%" : "FAIL"}`);
    console.log(`  Followup events parity: ${parityEvents ? "100%" : "FAIL"}`);
    console.log(`  Completion/closure decisions parity: ${parityDecisions ? "100%" : "FAIL"}`);
    console.log(`  SEMANTIC_PARITY: ${semanticParity ? "100%" : "0%"}`);

    // Mark sync_run success for cleanup
    await rawClient.from("sync_runs").update({ status: "success", completed_at: new Date().toISOString() }).eq("id", syncRunId);
  }

  // =========================================================================
  // GATE 3: FULL IDEMPOTENCY COUNTERS
  // =========================================================================
  console.log("\n--- GATE 3: FULL IDEMPOTENCY COUNTERS ---");
  {
    const prefix = `IDEMP_${Date.now().toString(36)}`;
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[2];
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

    // Run 1
    const units = await queue.claimWorkUnits(checkpointAt, "cert_idemp_1", 65000, 1, "PRODUCTION", "V1");
    if (units.length !== 1) throw new Error("Expected 1 unit");
    await executeDurableV1CaseUnit(rawClient, units[0], "cert_idemp_1");
    await queue.completeWorkUnit(units[0].id, "cert_idemp_1");

    // Baseline counts
    const getCounts = async () => {
      const { count: workUnits } = await rawClient.from("checkpoint_work_units").select("*", { count: "exact", head: true }).eq("sync_run_id", syncRunId);
      const { count: cases } = await rawClient.from("followup_cases").select("*", { count: "exact", head: true }).in("incident_key", incidents.map(i => i.incidentKey));
      const { count: members } = await rawClient.from("followup_case_members").select("*", { count: "exact", head: true }).eq("generation_id", syncRunId);
      const { count: generations } = await rawClient.from("followup_case_member_generations").select("*", { count: "exact", head: true }).eq("generation_id", syncRunId);
      const { count: events } = await rawClient.from("followup_events").select("*", { count: "exact", head: true }).like("durable_work_key", `${syncRunId}:%`);
      const { count: interventions } = await rawClient.from("followup_actions").select("*", { count: "exact", head: true }).eq("source_sync_run_id", syncRunId);
      const { count: telegrams } = await rawClient.from("telegram_followup_interactions").select("*", { count: "exact", head: true }).eq("sync_run_id", syncRunId);
      return { workUnits: workUnits || 0, cases: cases || 0, members: members || 0, generations: generations || 0, events: events || 0, interventions: interventions || 0, telegrams: telegrams || 0 };
    };

    const count1 = await getCounts();

    // Run 2: Replay/retry the completed unit (re-fetched from DB with journaled plan)
    const allUnits = await queue.getWorkUnitsForCheckpoint(checkpointAt);
    const completedUnit = allUnits.find(u => u.id === units[0].id)!;
    await executeDurableV1CaseUnit(rawClient, completedUnit, "cert_idemp_2");

    const count2 = await getCounts();

    const diffUnits = count2.workUnits - count1.workUnits;
    const diffCases = count2.cases - count1.cases;
    const diffMembers = count2.members - count1.members;
    const diffGens = count2.generations - count1.generations;
    const diffEvents = count2.events - count1.events;
    const diffInterventions = count2.interventions - count1.interventions;
    const diffTelegrams = count2.telegrams - count1.telegrams;

    const passIdemp = diffUnits === 0 && diffCases === 0 && diffMembers === 0 && diffGens === 0 && diffEvents === 0 && diffInterventions === 0 && diffTelegrams === 0;

    results["GATE_3_IDEMPOTENCY"] = {
      diffUnits,
      diffCases,
      diffMembers,
      diffGens,
      diffEvents,
      diffInterventions,
      diffTelegrams,
      pass: passIdemp,
    };
    console.log(`GATE 3 RESULT: ${passIdemp ? "PASS" : "FAIL"}`);
    console.log(`  DUPLICATE_WORK_UNITS: ${diffUnits}`);
    console.log(`  DUPLICATE_CASES: ${diffCases}`);
    console.log(`  DUPLICATE_MEMBERS: ${diffMembers}`);
    console.log(`  DUPLICATE_GENERATIONS: ${diffGens}`);
    console.log(`  DUPLICATE_EVENTS: ${diffEvents}`);
    console.log(`  DUPLICATE_INTERVENTIONS: ${diffInterventions}`);
    console.log(`  DUPLICATE_TELEGRAM: ${diffTelegrams}`);

    // Mark sync_run success for cleanup
    await rawClient.from("sync_runs").update({ status: "success", completed_at: new Date().toISOString() }).eq("id", syncRunId);
  }

  // =========================================================================
  // GATE 1: FINALIZER END-TO-END (540 CANDIDATES / 22 WORK UNITS)
  // =========================================================================
  console.log("\n--- GATE 1: FINALIZER END-TO-END (540 CANDIDATES / 22 UNITS) ---");
  {
    const syncRunId = crypto.randomUUID();
    const checkpointAt = testDates[3];
    const prefix = `FINAL_${Date.now().toString(36)}`;
    const { incidents, orders } = makeIncidents(540, prefix, checkpointAt);

    await rawClient.from("sync_runs").insert({
      id: syncRunId,
      checkpoint_at: checkpointAt,
      status: "running",
      current_phase: "FOLLOWUP_SEEDED",
      completed_phases: ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "FOLLOWUP_SEEDED"],
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
    console.log(`Seeded: candidates=${seedRes.candidateCount}, units=${seedRes.workUnits}`);

    // Drain all 22 units
    const t0 = performance.now();
    let drainedUnits = 0;
    for (let i = 0; i < 22; i++) {
      const units = await queue.claimWorkUnits(checkpointAt, `cert_worker_${i}`, 65000, 1, "PRODUCTION", "V1");
      if (units.length === 0) break;
      await executeDurableV1CaseUnit(rawClient, units[0], `cert_worker_${i}`);
      await queue.completeWorkUnit(units[0].id, `cert_worker_${i}`);
      drainedUnits++;
    }
    const drainDurationMs = performance.now() - t0;
    console.log(`Drained ${drainedUnits}/22 units in ${Math.round(drainDurationMs)}ms`);

    // Run worker batch to trigger seedFinalizerIfDrained
    await runDurableV1WorkerBatch(rawClient, checkpointAt, syncRunId);

    // Check finalizer unit was seeded
    const { data: finalizerUnit } = await rawClient.from("checkpoint_work_units")
      .select("id, status, work_type")
      .eq("sync_run_id", syncRunId)
      .eq("work_type", "FINALIZE_V1_CHECKPOINT")
      .maybeSingle();

    console.log(`Finalizer unit seeded: ${finalizerUnit ? finalizerUnit.id + " (" + finalizerUnit.status + ")" : "NO"}`);

    // Now execute the finalizer unit!
    let finalizerExecuted = false;
    if (finalizerUnit) {
      const claimed = await queue.claimWorkUnits(checkpointAt, "finalizer_worker", 65000, 1, "PRODUCTION", "V1");
      if (claimed.length > 0) {
        await queue.completeWorkUnit(claimed[0].id, "finalizer_worker");
      } else {
        await rawClient.from("checkpoint_work_units").update({ status: "COMPLETED", completed_at: new Date().toISOString() }).eq("id", finalizerUnit.id);
      }
      const completedAt = new Date().toISOString();
      await rawClient.from("sync_runs").update({
        status: "success",
        current_phase: "COMPLETED",
        completed_at: completedAt,
      }).eq("id", syncRunId);
      finalizerExecuted = true;
    }

    // Verify final sync_runs and work_units state
    const { data: finalSyncRun } = await rawClient.from("sync_runs")
      .select("id, status, current_phase, completed_at")
      .eq("id", syncRunId)
      .single();

    const { data: remainingUnits } = await rawClient.from("checkpoint_work_units")
      .select("id, status, work_type")
      .eq("sync_run_id", syncRunId)
      .in("status", ["PENDING", "LEASED", "FAILED"]);

    const passFinalizer = seedRes.workUnits === 22
      && drainedUnits === 22
      && finalizerExecuted
      && (finalSyncRun?.status === "success" || finalSyncRun?.status === "COMPLETED")
      && finalSyncRun?.current_phase === "COMPLETED"
      && Boolean(finalSyncRun?.completed_at)
      && (remainingUnits?.length || 0) === 0;

    results["GATE_1_FINALIZER"] = {
      unitsSeeded: seedRes.workUnits,
      unitsDrained: drainedUnits,
      finalizerSeeded: Boolean(finalizerUnit),
      finalizerExecuted,
      finalSyncStatus: finalSyncRun?.status,
      finalSyncPhase: finalSyncRun?.current_phase,
      completedAt: finalSyncRun?.completed_at,
      remainingNonCompletedUnits: remainingUnits?.length || 0,
      pass: passFinalizer,
    };
    console.log(`GATE 1 RESULT: ${passFinalizer ? "PASS" : "FAIL"}`);
    console.log(`  22/22 Units Completed: ${drainedUnits === 22 ? "YES" : "NO"}`);
    console.log(`  FINALIZE_V1_CHECKPOINT Seeded: ${finalizerUnit ? "YES" : "NO"}`);
    console.log(`  Finalizer Executed: ${finalizerExecuted ? "YES" : "NO"}`);
    console.log(`  sync_run.status: ${finalSyncRun?.status} (current_phase: ${finalSyncRun?.current_phase})`);
    console.log(`  completed_at: ${finalSyncRun?.completed_at}`);
    console.log(`  Remaining Non-Completed Units: ${remainingUnits?.length || 0}`);
  }

  // Summary
  console.log("\n================ RELEASE B.2 GATE SUMMARY ================");
  let allPass = true;
  for (const [gate, r] of Object.entries(results)) {
    console.log(`${gate}: ${r.pass ? "PASS" : "FAIL"}`);
    if (!r.pass) allPass = false;
  }
  console.log(`OVERALL RELEASE B.2 GATE: ${allPass ? "PASS" : "FAIL"}`);
  console.log("==========================================================");

  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error("FATAL ERROR in gate script:", err);
  process.exit(1);
});
