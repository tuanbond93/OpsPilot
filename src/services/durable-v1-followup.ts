import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { Incident } from "@/engine/incident";
import { SupabaseCheckpointWorkQueueRepository } from "@/repositories/supabase/SupabaseCheckpointWorkQueueRepository";

export const V1_FOLLOWUP_CHUNK_SIZE = 25;
const V1_WORK_TYPE = "EVALUATE_FOLLOWUP_BATCH";

export function durableV1InputHash(checkpointAt: string, orders: NormalizedRillnetOrder[], incidents: Incident[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical({
    checkpointAt: new Date(checkpointAt).toISOString(), orders, incidents,
  }))).digest("hex");
}

export interface DurableV1Input {
  checkpointAt: string;
  syncRunId: string;
  referenceTimeMs: number;
  orders: NormalizedRillnetOrder[];
  incidents: Incident[];
}

export interface DurableV1SeedResult {
  candidateCount: number;
  workUnits: number;
  newlyCreatedUnits: number;
}

type CaseIdentity = { id: string; incident_key: string; updated_at: string; current_state: string };

/** Parent identities only: never hydrate generations in the producer. */
async function listOpenCaseIdentities(client: SupabaseClient): Promise<CaseIdentity[]> {
  const rows: CaseIdentity[] = [];
  let cursor: CaseIdentity | undefined;
  for (;;) {
    const query = client.from("followup_cases")
      .select("id,incident_key,updated_at,current_state")
      .neq("current_state", "CLOSED")
      .not("operational_cohort", "is", null);
    if (cursor) query.or(`updated_at.lt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},id.lt.${cursor.id})`);
    const { data, error } = await query
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1000);
    if (error) throw error;
    const page = (data || []) as CaseIdentity[];
    rows.push(...page);
    if (page.length < 1000) break;
    cursor = page[page.length - 1];
  }
  return rows;
}

export function partitionV1CandidateKeys(keys: string[], chunkSize = V1_FOLLOWUP_CHUNK_SIZE): string[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("V1_FOLLOWUP_CHUNK_SIZE_INVALID");
  const unique = new Set(keys);
  if (unique.size !== keys.length || keys.some(key => !key)) throw new Error("V1_FOLLOWUP_CANDIDATE_IDENTITY_DUPLICATE");
  const chunks: string[][] = [];
  for (let offset = 0; offset < keys.length; offset += chunkSize) chunks.push(keys.slice(offset, offset + chunkSize));
  return chunks;
}

/** Save the exact source and incident objects before the history barrier. */
export async function persistDurableV1Input(client: SupabaseClient, input: DurableV1Input): Promise<void> {
  const { checkpointAt, syncRunId } = input;
  const inputSha256 = durableV1InputHash(checkpointAt, input.orders, input.incidents);
  const { data: prior, error: priorError } = await client.from("checkpoint_v1_followup_inputs")
    .select("checkpoint_at,input_sha256")
    .eq("sync_run_id", syncRunId).maybeSingle();
  if (priorError) throw priorError;
  if (prior) {
    if (new Date(prior.checkpoint_at).toISOString() !== new Date(checkpointAt).toISOString()
      || prior.input_sha256 !== inputSha256) {
      throw new Error("V1_DURABLE_INPUT_CHECKPOINT_MISMATCH");
    }
    return;
  }
  const { error: insertError } = await client.from("checkpoint_v1_followup_inputs").insert({
    sync_run_id: syncRunId,
    checkpoint_at: checkpointAt,
    reference_time_ms: input.referenceTimeMs,
    orders: input.orders,
    incidents: input.incidents,
    candidate_keys: [],
    input_sha256: inputSha256,
  });
  if (insertError && insertError.code !== "23505") throw insertError;
  if (insertError) {
    const { data: concurrent, error } = await client.from("checkpoint_v1_followup_inputs")
      .select("input_sha256")
      .eq("sync_run_id", syncRunId).single();
    if (error) throw error;
    if (concurrent.input_sha256 !== inputSha256) throw new Error("V1_DURABLE_INPUT_CONCURRENT_MISMATCH");
  }
}

export async function seedDurableV1Followups(
  client: SupabaseClient,
  checkpointAt: string,
  syncRunId: string,
): Promise<DurableV1SeedResult> {
  const { data: stored, error: inputError } = await client.from("checkpoint_v1_followup_inputs")
    .select("checkpoint_at,incidents,candidate_keys,producer_completed_at")
    .eq("sync_run_id", syncRunId).single();
  if (inputError) throw inputError;
  if (new Date(stored.checkpoint_at).toISOString() !== new Date(checkpointAt).toISOString()) {
    throw new Error("V1_DURABLE_INPUT_CHECKPOINT_MISMATCH");
  }
  let candidateKeys = stored.candidate_keys as string[];
  if (!stored.producer_completed_at && candidateKeys.length === 0) {
    const existing = await listOpenCaseIdentities(client);
    const keys = (stored.incidents as Incident[]).map(incident => incident.incidentKey);
    const seen = new Set(keys);
    for (const row of existing) if (!seen.has(row.incident_key)) {
      seen.add(row.incident_key);
      keys.push(row.incident_key);
    }
    candidateKeys = keys;
    const { error } = await client.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: candidateKeys }).eq("sync_run_id", syncRunId)
      .is("producer_completed_at", null);
    if (error) throw error;
  }

  const chunks = partitionV1CandidateKeys(candidateKeys);
  const queue = new SupabaseCheckpointWorkQueueRepository(client);
  const units = chunks.map((keys, chunkIndex) => ({
    checkpointAt,
    syncRunId,
    stage: "FOLLOWUPS_PROCESSING" as const,
    workType: V1_WORK_TYPE as "EVALUATE_FOLLOWUP_BATCH",
    partitionKey: `v1_followup_${chunkIndex}_of_${chunks.length}`,
    cursor: {
      offset: chunkIndex * V1_FOLLOWUP_CHUNK_SIZE,
      limit: keys.length,
      total: candidateKeys.length,
      metadata: { pipelineVersion: "V1", chunkIndex, caseKeys: keys },
    },
    executionMode: "PRODUCTION" as const,
    idempotencyKey: `${checkpointAt}:${syncRunId}:V1:${chunkIndex}`,
  }));
  const newlyCreatedUnits = await queue.createWorkUnits(units);
  const persisted = (await queue.getWorkUnitsForCheckpoint(checkpointAt))
    .filter(unit => unit.syncRunId === syncRunId && unit.workType === V1_WORK_TYPE
      && unit.idempotencyKey.startsWith(`${checkpointAt}:${syncRunId}:V1:`));
  const persistedByKey = new Map(persisted.map(unit => [unit.idempotencyKey, unit]));
  if (persisted.length !== units.length || units.some((expected, index) =>
    JSON.stringify(persistedByKey.get(expected.idempotencyKey)?.cursor.metadata?.caseKeys) !== JSON.stringify(chunks[index]))) {
    throw new Error(`V1_DURABLE_WORK_MANIFEST_MISMATCH:${persisted.length}/${units.length}`);
  }
  const { error: completedError } = await client.from("checkpoint_v1_followup_inputs")
    .update({ producer_completed_at: new Date().toISOString() })
    .eq("sync_run_id", syncRunId)
    .is("producer_completed_at", null);
  if (completedError) throw completedError;
  if (chunks.length === 0) {
    await queue.createWorkUnits([{
      checkpointAt, syncRunId,
      stage: "FOLLOWUPS_COMPLETE",
      workType: "FINALIZE_V1_CHECKPOINT",
      partitionKey: "v1_finalize",
      cursor: { offset: 0, limit: 1, metadata: { pipelineVersion: "V1" } },
      executionMode: "PRODUCTION",
      idempotencyKey: `${checkpointAt}:${syncRunId}:V1:finalize`,
    }]);
  }
  return { candidateCount: candidateKeys.length, workUnits: units.length, newlyCreatedUnits };
}
