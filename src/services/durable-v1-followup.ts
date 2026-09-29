import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { Incident } from "@/engine/incident";
import { SupabaseCheckpointWorkQueueRepository } from "@/repositories/supabase/SupabaseCheckpointWorkQueueRepository";

export const V1_FOLLOWUP_CHUNK_SIZE = 25;
export const V1_FOLLOWUP_MAX_MEMBERS = 2500;
export const V1_FOLLOWUP_MAX_INPUT_BYTES = 2_000_000;
const V1_WORK_TYPE = "EVALUATE_FOLLOWUP_BATCH";

export function durableV1InputHash(checkpointAt: string, orders: unknown[], incidents: Incident[]): string {
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

export interface DurableV1SeedOptions {
  orders?: NormalizedRillnetOrder[];
}

export interface DurableV1SeedResult {
  candidateCount: number;
  workUnits: number;
  newlyCreatedUnits: number;
}

type CaseIdentity = {
  id: string;
  incident_key: string;
  updated_at: string;
  current_state: string;
  operational_cohort?: { members?: Array<{ orderCode?: string }> } | null;
};

/** Parent identities only: never hydrate generations in the producer. */
async function listOpenCaseIdentities(client: SupabaseClient): Promise<CaseIdentity[]> {
  const rows: CaseIdentity[] = [];
  let cursor: CaseIdentity | undefined;
  for (;;) {
    const query = client.from("followup_cases")
      .select("id,incident_key,updated_at,current_state,operational_cohort")
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

export function partitionWeightedV1Candidates(
  keys: string[],
  orderCodesByCaseKey: ReadonlyMap<string, ReadonlySet<string>>,
  ordersByCode: ReadonlyMap<string, NormalizedRillnetOrder>,
  limits = {
    maxCases: V1_FOLLOWUP_CHUNK_SIZE,
    maxMembers: V1_FOLLOWUP_MAX_MEMBERS,
    maxInputBytes: V1_FOLLOWUP_MAX_INPUT_BYTES,
  },
): string[][] {
  if (![limits.maxCases, limits.maxMembers, limits.maxInputBytes]
    .every(value => Number.isInteger(value) && value > 0)) throw new Error("V1_FOLLOWUP_PARTITION_LIMIT_INVALID");
  const unique = new Set(keys);
  if (unique.size !== keys.length || keys.some(key => !key)) throw new Error("V1_FOLLOWUP_CANDIDATE_IDENTITY_DUPLICATE");

  const chunks: string[][] = [];
  let currentKeys: string[] = [];
  let currentCodes = new Set<string>();
  const projectedBytes = (codes: ReadonlySet<string>) => Buffer.byteLength(JSON.stringify(
    [...codes].flatMap(code => {
      const order = ordersByCode.get(code);
      return order ? [order] : [];
    }),
  ), "utf8");

  for (const key of keys) {
    const nextCodes = new Set(currentCodes);
    for (const code of orderCodesByCaseKey.get(key) || []) {
      if (ordersByCode.has(code)) nextCodes.add(code);
    }
    const exceeds = currentKeys.length > 0 && (
      currentKeys.length + 1 > limits.maxCases
      || nextCodes.size > limits.maxMembers
      || projectedBytes(nextCodes) > limits.maxInputBytes
    );
    if (exceeds) {
      chunks.push(currentKeys);
      currentKeys = [];
      currentCodes = new Set();
    }
    currentKeys.push(key);
    for (const code of orderCodesByCaseKey.get(key) || []) {
      if (ordersByCode.has(code)) currentCodes.add(code);
    }
  }
  if (currentKeys.length > 0) chunks.push(currentKeys);
  return chunks;
}

/** Save the lightweight manifest (incidents, metadata, and empty orders array) before the history barrier. */
export async function persistDurableV1Input(client: SupabaseClient, input: DurableV1Input): Promise<void> {
  const { checkpointAt, syncRunId } = input;
  // Manifest orders are intentionally an empty array [] to eliminate the giant unpartitioned write.
  // Chunk orders are persisted deterministically per bounded 25-case work unit in checkpoint_v1_followup_input_chunks.
  const manifestOrders: unknown[] = [];
  const inputSha256 = durableV1InputHash(checkpointAt, manifestOrders, input.incidents);
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
    orders: manifestOrders,
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
  options?: DurableV1SeedOptions,
): Promise<DurableV1SeedResult> {
  const { data: stored, error: inputError } = await client.from("checkpoint_v1_followup_inputs")
    .select("checkpoint_at,incidents,candidate_keys,producer_completed_at")
    .eq("sync_run_id", syncRunId).single();
  if (inputError) throw inputError;
  if (new Date(stored.checkpoint_at).toISOString() !== new Date(checkpointAt).toISOString()) {
    throw new Error("V1_DURABLE_INPUT_CHECKPOINT_MISMATCH");
  }

  let candidateKeys = stored.candidate_keys as string[];
  let existingCases: CaseIdentity[] = [];
  if (!stored.producer_completed_at && candidateKeys.length === 0) {
    existingCases = await listOpenCaseIdentities(client);
    const keys = (stored.incidents as Incident[]).map(incident => incident.incidentKey);
    const seen = new Set(keys);
    for (const row of existingCases) if (!seen.has(row.incident_key)) {
      seen.add(row.incident_key);
      keys.push(row.incident_key);
    }
    candidateKeys = keys;
    const { error } = await client.from("checkpoint_v1_followup_inputs")
      .update({ candidate_keys: candidateKeys }).eq("sync_run_id", syncRunId)
      .is("producer_completed_at", null);
    if (error) throw error;
  } else if (!stored.producer_completed_at && candidateKeys.length > 0) {
    existingCases = await listOpenCaseIdentities(client);
  }

  // Map each candidate key to its required order codes
  const orderCodesByCaseKey = new Map<string, Set<string>>();
  for (const inc of (stored.incidents as Incident[])) {
    if (!orderCodesByCaseKey.has(inc.incidentKey)) orderCodesByCaseKey.set(inc.incidentKey, new Set());
    for (const code of (inc.affectedOrders || [])) orderCodesByCaseKey.get(inc.incidentKey)!.add(code);
  }
  for (const c of existingCases) {
    if (!orderCodesByCaseKey.has(c.incident_key)) orderCodesByCaseKey.set(c.incident_key, new Set());
    for (const m of (c.operational_cohort?.members || [])) {
      if (m?.orderCode) orderCodesByCaseKey.get(c.incident_key)!.add(m.orderCode);
    }
  }

  // Build index of available orders
  const ordersByCode = new Map<string, NormalizedRillnetOrder>();
  if (options?.orders) {
    for (const o of options.orders) {
      ordersByCode.set(o.orderCode, o);
    }
  }

  const chunks = partitionWeightedV1Candidates(candidateKeys, orderCodesByCaseKey, ordersByCode);

  // Pre-project chunk orders and chunk incidents
  const incidentMap = new Map((stored.incidents as Incident[]).map(inc => [inc.incidentKey, inc]));
  const chunkRows: Array<{
    sync_run_id: string;
    chunk_index: number;
    deterministic_work_key: string;
    orders: NormalizedRillnetOrder[];
    incidents: Incident[];
  }> = [];
  const chunkOrdersList: NormalizedRillnetOrder[][] = [];

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const keys = chunks[chunkIndex];
    const chunkCodes = new Set<string>();
    for (const key of keys) {
      const codes = orderCodesByCaseKey.get(key);
      if (codes) for (const c of codes) chunkCodes.add(c);
    }

    const chunkOrders: NormalizedRillnetOrder[] = [];
    for (const code of chunkCodes) {
      const rawOrder = ordersByCode.get(code);
      if (rawOrder) {
        chunkOrders.push(rawOrder);
      }
    }

    const chunkIncidents = keys.flatMap(k => {
      const inc = incidentMap.get(k);
      return inc ? [inc] : [];
    });

    const deterministicWorkKey = `${checkpointAt}:${syncRunId}:V1:${chunkIndex}`;
    chunkOrdersList.push(chunkOrders);
    chunkRows.push({
      sync_run_id: syncRunId,
      chunk_index: chunkIndex,
      deterministic_work_key: deterministicWorkKey,
      orders: chunkOrders,
      incidents: chunkIncidents,
    });
  }

  if (chunkRows.length > 0) {
    const { error: chunkError } = await client
      .from("checkpoint_v1_followup_input_chunks")
      .upsert(chunkRows, { onConflict: "sync_run_id,chunk_index" });
    if (chunkError) throw chunkError;
  }

  const queue = new SupabaseCheckpointWorkQueueRepository(client);
  let caseOffset = 0;
  const units = chunks.map((keys, chunkIndex) => {
    const offset = caseOffset;
    caseOffset += keys.length;
    return ({
    checkpointAt,
    syncRunId,
    stage: "FOLLOWUPS_PROCESSING" as const,
    workType: V1_WORK_TYPE as "EVALUATE_FOLLOWUP_BATCH",
    partitionKey: `v1_followup_${chunkIndex}_of_${chunks.length}`,
    cursor: {
      offset,
      limit: keys.length,
      total: candidateKeys.length,
      metadata: {
        pipelineVersion: "V1",
        chunkIndex,
        caseKeys: keys,
        chunkOrders: chunkOrdersList[chunkIndex],
      },
    },
    executionMode: "PRODUCTION" as const,
    idempotencyKey: `${checkpointAt}:${syncRunId}:V1:${chunkIndex}`,
    });
  });
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
