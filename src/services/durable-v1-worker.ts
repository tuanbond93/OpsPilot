import type { SupabaseClient } from "@supabase/supabase-js";
import { durableV1InputHash } from "@/services/durable-v1-followup";
import type { Incident } from "@/engine/incident";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { CheckpointWorkUnit } from "@/domain/checkpoint-v2/types";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { ActionQueue } from "@/engine/action-queue";
import { FollowupEngine, type DurableV1FollowupPlan } from "@/engine/followup/followup-engine";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";
import { SupabaseCheckpointWorkQueueRepository } from "@/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";
import { persistCheckpointDispatchAudit } from "@/services/checkpoint-dispatch-audit";
import { queuePhase2CheckpointWork } from "@/services/phase2-checkpoint-work";

type StoredInput = {
  checkpoint_at: string;
  reference_time_ms: number;
  orders: NormalizedRillnetOrder[];
  incidents: Incident[];
  candidate_keys: string[];
  producer_completed_at: string | null;
  input_sha256: string;
};

function v1CaseKeys(unit: CheckpointWorkUnit): string[] {
  if (unit.executionMode !== "PRODUCTION"
    || unit.cursor.metadata?.pipelineVersion !== "V1"
    || unit.workType !== "EVALUATE_FOLLOWUP_BATCH") {
    throw new Error(`V1_WORKER_UNIT_IDENTITY_INVALID:${unit.id}`);
  }
  const keys = unit.cursor.metadata.caseKeys;
  if (!Array.isArray(keys) || keys.length > 25 || keys.some(key => typeof key !== "string" || !key)) {
    throw new Error(`V1_WORKER_CANDIDATE_KEYS_INVALID:${unit.id}`);
  }
  return keys;
}

async function loadInput(client: SupabaseClient, unit: CheckpointWorkUnit): Promise<StoredInput> {
  const { data, error } = await client.from("checkpoint_v1_followup_inputs")
    .select("checkpoint_at,reference_time_ms,orders,incidents,candidate_keys,producer_completed_at,input_sha256")
    .eq("sync_run_id", unit.syncRunId).single();
  if (error) throw error;
  if (!data.producer_completed_at
    || new Date(data.checkpoint_at).toISOString() !== new Date(unit.checkpointAt).toISOString()) {
    throw new Error("V1_WORKER_INPUT_NOT_READY");
  }
  const actualHash = durableV1InputHash(data.checkpoint_at, data.orders, data.incidents);
  if (actualHash !== data.input_sha256) throw new Error("V1_WORKER_INPUT_HASH_MISMATCH");
  return data as StoredInput;
}

async function journalPlan(client: SupabaseClient, unit: CheckpointWorkUnit, workerId: string, plan: DurableV1FollowupPlan): Promise<void> {
  const { data, error } = await client.from("checkpoint_work_units")
    .update({ cursor: { ...unit.cursor, metadata: { ...unit.cursor.metadata, plan } } })
    .eq("id", unit.id).eq("status", "LEASED").eq("lease_owner", workerId)
    .select("id");
  if (error) throw error;
  if (data?.length !== 1) throw new Error("V1_WORKER_LEASE_LOST_BEFORE_PLAN_JOURNAL");
}

export async function executeDurableV1CaseUnit(
  client: SupabaseClient,
  unit: CheckpointWorkUnit,
  workerId: string,
): Promise<{ itemsProcessed: number }> {
  const keys = v1CaseKeys(unit);
  const input = await loadInput(client, unit);
  const repo = new SupabaseFollowupRepository(client);
  const engine = new FollowupEngine(repo, new ActionQueue(client));
  const priorPlan = unit.cursor.metadata?.plan as DurableV1FollowupPlan | undefined;
  if (priorPlan) {
    await engine.replayDurableV1Plan(priorPlan, unit.syncRunId);
    return { itemsProcessed: keys.length };
  }

  const keySet = new Set(keys);
  if (keySet.size !== keys.length || keys.some(key => !input.candidate_keys.includes(key))) {
    throw new Error("V1_WORKER_CANDIDATE_MANIFEST_MISMATCH");
  }

  // Load chunk orders: prefer cursor.metadata.chunkOrders (0 queries), then checkpoint_v1_followup_input_chunks, then fallback to input.orders
  let chunkOrders: NormalizedRillnetOrder[] = (unit.cursor.metadata?.chunkOrders as NormalizedRillnetOrder[] | undefined) || [];
  let chunkIncidents: Incident[] = [];

  if (chunkOrders.length === 0) {
    const chunkIndex = unit.cursor.metadata?.chunkIndex;
    if (typeof chunkIndex === "number") {
      const { data: chunkRow } = await client.from("checkpoint_v1_followup_input_chunks")
        .select("orders,incidents")
        .eq("sync_run_id", unit.syncRunId)
        .eq("chunk_index", chunkIndex)
        .maybeSingle();
      if (chunkRow?.orders) {
        chunkOrders = chunkRow.orders as NormalizedRillnetOrder[];
      }
      if (chunkRow?.incidents) {
        chunkIncidents = chunkRow.incidents as Incident[];
      }
    }
  }

  if (chunkOrders.length === 0 && input.orders && input.orders.length > 0) {
    chunkOrders = input.orders;
  }

  const incidents = chunkIncidents.length > 0
    ? chunkIncidents.filter(incident => keySet.has(incident.incidentKey))
    : input.incidents.filter(incident => keySet.has(incident.incidentKey));

  const cases = await repo.getCasesByIncidentKeys(keys);
  await engine.processIncidentFollowups(
    incidents,
    new Map(),
    undefined,
    input.reference_time_ms,
    chunkOrders as NormalizedRillnetOrder[],
    unit.syncRunId,
    { existingCases: cases, journalPlan: plan => journalPlan(client, unit, workerId, plan) },
  );
  return { itemsProcessed: keys.length };
}

async function v1CaseUnits(client: SupabaseClient, checkpointAt: string, syncRunId: string) {
  const queue = new SupabaseCheckpointWorkQueueRepository(client);
  return (await queue.getWorkUnitsForCheckpoint(checkpointAt))
    .filter(unit => unit.syncRunId === syncRunId
      && unit.workType === "EVALUATE_FOLLOWUP_BATCH"
      && unit.cursor.metadata?.pipelineVersion === "V1");
}

async function seedFinalizerIfDrained(client: SupabaseClient, checkpointAt: string, syncRunId: string) {
  const units = await v1CaseUnits(client, checkpointAt, syncRunId);
  const { data: input, error } = await client.from("checkpoint_v1_followup_inputs")
    .select("candidate_keys,producer_completed_at")
    .eq("sync_run_id", syncRunId).single();
  if (error) throw error;
  const expected = Math.ceil((input.candidate_keys as string[]).length / 25);
  if (!input.producer_completed_at || units.length !== expected
    || units.some(unit => unit.status !== "COMPLETED")) return false;
  const queue = new SupabaseCheckpointWorkQueueRepository(client);
  await queue.createWorkUnits([{
    checkpointAt, syncRunId,
    stage: "FOLLOWUPS_COMPLETE",
    workType: "FINALIZE_V1_CHECKPOINT",
    partitionKey: "v1_finalize",
    cursor: { offset: 0, limit: 1, metadata: { pipelineVersion: "V1" } },
    executionMode: "PRODUCTION",
    idempotencyKey: `${checkpointAt}:${syncRunId}:V1:finalize`,
  }]);
  return true;
}

async function executeDurableV1Finalizer(client: SupabaseClient, unit: CheckpointWorkUnit) {
  const units = await v1CaseUnits(client, unit.checkpointAt, unit.syncRunId);
  const { data: input, error } = await client.from("checkpoint_v1_followup_inputs")
    .select("checkpoint_at,reference_time_ms,incidents,candidate_keys,producer_completed_at")
    .eq("sync_run_id", unit.syncRunId).single();
  if (error) throw error;
  const expected = Math.ceil((input.candidate_keys as string[]).length / 25);
  if (!input.producer_completed_at || units.length !== expected
    || units.some(item => item.status !== "COMPLETED")) {
    throw new Error("V1_FINALIZER_WORK_NOT_DRAINED");
  }
  const results = units.flatMap(item => {
    const plan = item.cursor.metadata?.plan as DurableV1FollowupPlan | undefined;
    if (!plan) throw new Error(`V1_FINALIZER_PLAN_MISSING:${item.id}`);
    return plan.results;
  });
  const { data: run, error: runError } = await client.from("sync_runs")
    .select("id,status,completed_phases,started_at")
    .eq("id", unit.syncRunId).single();
  if (runError) throw runError;
  if (run.status !== "success") {
    const phases = Array.isArray(run.completed_phases) ? [...run.completed_phases] : [];
    if (!phases.includes("PROCESSING_FOLLOWUPS")) phases.push("PROCESSING_FOLLOWUPS");
    const { error: phaseError } = await client.from("sync_runs")
      .update({ current_phase: "PROCESSING_FOLLOWUPS", completed_phases: phases })
      .eq("id", unit.syncRunId).eq("status", "running");
    if (phaseError) throw phaseError;
  }
  const sync = await syncRillnet({
    checkpointAt: unit.checkpointAt,
    durableV1Finalization: { incidents: input.incidents as Incident[], followupResults: results },
  });
  if (!sync.ok) throw new Error(`V1_FINALIZER_SYNC_FAILED:${sync.error?.code || "UNKNOWN"}`);
  const telegram = await runTelegramFollowupPilotDispatch(client, "followup_cycle", input.reference_time_ms);
  const statusUpdates = await sendIncidentSyncStatus(client, unit.syncRunId, sync.completedAt || new Date().toISOString());
  if (telegram.failed || statusUpdates.failed) throw new Error("V1_FINALIZER_DELIVERY_FAILED");
  const evaluation = sync.followupEvaluation;
  await persistCheckpointDispatchAudit(client, {
    checkpointAt: unit.checkpointAt,
    syncRunId: unit.syncRunId,
    startedAt: run.started_at,
    completedAt: sync.completedAt,
    executionStatus: "SUCCESS",
    httpStatus: 200,
    supportedCasesEvaluated: evaluation?.supportedCasesEvaluated,
    khoTonEvaluated: evaluation?.khoTonEvaluated,
    khoChuaLuanChuyenEvaluated: evaluation?.khoChuaLuanChuyenEvaluated,
    firstPushPendingCreated: evaluation?.pendingCreated.first,
    secondPushPendingCreated: evaluation?.pendingCreated.second,
    thirdPushPendingCreated: evaluation?.pendingCreated.third,
    escalationPendingCreated: evaluation?.pendingCreated.escalation,
    telegramScanned: telegram.scanned,
    recipientsResolved: telegram.recipientsResolved,
    interactionsCreated: telegram.interactionsCreated,
    sendAttempts: telegram.sendAttempts,
    sendSuccess: telegram.sent,
    sendFailed: telegram.failed,
    statusUpdatesActive: statusUpdates.active,
    statusUpdatesResolved: statusUpdates.resolved,
    statusUpdateBatchesSent: statusUpdates.sentBatches,
    statusUpdateBatchesFailed: statusUpdates.failed,
  });
  await queuePhase2CheckpointWork(client, { checkpointAt: unit.checkpointAt, syncRunId: unit.syncRunId });
  return { itemsProcessed: 1 };
}

export async function runDurableV1WorkerBatch(client: SupabaseClient, checkpointAt: string, syncRunId: string) {
  const queue = new SupabaseCheckpointWorkQueueRepository(client);
  const worker = new CheckpointWorker(queue, {
    softBudgetMs: 35_000,
    safeTailMarginMs: 5_000,
    warningBudgetMs: 40_000,
    criticalBudgetMs: 45_000,
    platformCeilingMs: 60_000,
    leaseDurationMs: 65_000,
    maxUnitsPerClaim: 1,
  }, "v1_followup");
  const summary = await worker.runLoop(checkpointAt, syncRunId,
    (unit, workerId) => unit.workType === "FINALIZE_V1_CHECKPOINT"
      ? executeDurableV1Finalizer(client, unit)
      : executeDurableV1CaseUnit(client, unit, workerId),
    "PRODUCTION", "V1");
  await seedFinalizerIfDrained(client, checkpointAt, syncRunId);
  return summary;
}
