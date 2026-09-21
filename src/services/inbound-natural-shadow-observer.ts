import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateInboundBucket,
  classifyInboundCandidates,
  type NormalizedInboundCandidate,
} from "@/domain/near-term-capacity/inbound-evidence-service";
import { normalizeProvinceName } from "@/integrations/telegram/topic-router";
import { resolveProvince } from "@/notifications/gateway/scope-resolver";
import { logger } from "@/observability/logger";
import {
  diagnoseNaturalShadowRpcError,
  naturalShadowSafeFailureReason,
  unexpectedNaturalShadowRpcResultDiagnosis,
  type NaturalShadowRpcDiagnosis,
} from "@/services/inbound-natural-shadow-rpc-diagnostics";
import {
  buildNaturalShadowConstraintSnapshot,
  evaluateNaturalShadowChecks,
  type LocalCheckPreflight,
} from "@/services/inbound-natural-shadow-constraint-diagnostics";

export const NATURAL_SHADOW_TRIGGER_SOURCE = "opspilot-followup-cycle" as const;

export const NATURAL_SHADOW_PILOT_WAREHOUSES = [
  { id: "21161000", name: "Kho Giao Hàng Nặng - TP Yên Bái", province: "Yên Bái" },
  { id: "21158000", name: "Kho Giao Hàng Nặng - TP Lào Cai", province: "Lào Cai" },
  { id: "21160000", name: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ", province: "Phú Thọ" },
] as const;

type SourceRow = {
  order_code: string;
  current_warehouse_id: string | null;
  deliver_warehouse_id: string | null;
  source_status: string;
  end_pick_at: string | null;
  weight_kg: number | string | null;
  is_b2b: boolean | null;
  source_observed_at: string;
};

type ShadowWarehouseEvidence = {
  warehouse_id: string;
  warehouse_name: string;
  backlog_orders: number;
  pipeline_orders: number;
  pipeline_known_kg: number;
  pipeline_unknown_weight_orders: number;
  picked_not_transferred_orders: number;
  in_transfer_orders: number;
  arrival_confirmed_orders: number;
  eta_known_orders: number;
  eta_unknown_orders: number;
  arrival_within_horizon_status: "UNKNOWN";
  arrival_within_horizon_orders: null;
  pipeline_pressure: "LOW" | "MEDIUM" | "HIGH";
  near_term_arrival_risk: "UNKNOWN";
  routing_chat_id: string;
  routing_topic_id: string;
  source_freshness: string;
  shadow_message_text: string;
  shadow_message_generated: true;
};

export type NaturalShadowObserverResult =
  | { status: "SUCCESS_INSERTED" | "SUCCESS_ALREADY_OBSERVED"; checkpointId: string | null; warehousesEvaluated: 3 }
  | { status: "FAILED"; reason: string; warehousesEvaluated: 0 | 3; diagnosis?: NaturalShadowRpcDiagnosis; preflight?: LocalCheckPreflight };

type NaturalShadowStage =
  | "OBSERVER_ENTER"
  | "SYNC_RUN_VALIDATION"
  | "MANIFEST_VALIDATION"
  | "OBSERVATION_READ"
  | "OBSERVATION_RECONCILIATION"
  | "ROUTING_TOPIC_RESOLUTION"
  | "ROUTING_GROUP_RESOLUTION"
  | "WAREHOUSE_EVIDENCE_BUILD"
  | "RPC_ATTEMPT"
  | "RPC_RESULT"
  | "OBSERVER_COMPLETE";

type ObserverTelemetry = {
  syncRunId: string;
  checkpointAt: string;
  currentStage: NaturalShadowStage;
  startedAt: number;
};

function telemetry(telemetryState: ObserverTelemetry, stage: NaturalShadowStage, status: "START" | "PASS" | "FAIL", fields: Record<string, number | string> = {}) {
  telemetryState.currentStage = stage;
  try {
    logger.info({
      event: "INBOUND_NATURAL_SHADOW_STAGE",
      sync_run_id: telemetryState.syncRunId,
      checkpoint_at: telemetryState.checkpointAt,
      stage,
      status,
      ...fields,
    });
  } catch {
    // Telemetry is strictly best-effort and cannot change observer behavior.
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Only governed codes are loggable. Database/provider error text may contain
  // identifiers and is deliberately reduced to an opaque safe classification.
  const governed = message.match(/NATURAL_SHADOW_[A-Z0-9_]+/i);
  return governed ? governed[0].toUpperCase() : "UNCLASSIFIED_ERROR";
}

type StagedNaturalShadowError = Error & {
  naturalShadowStage?: NaturalShadowStage;
  naturalShadowErrorCode?: string;
  naturalShadowDiagnosis?: NaturalShadowRpcDiagnosis;
  naturalShadowPreflight?: LocalCheckPreflight;
};

function stagedError(stage: NaturalShadowStage, error: unknown, diagnosis?: NaturalShadowRpcDiagnosis, preflight?: LocalCheckPreflight): StagedNaturalShadowError {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  Object.assign(wrapped, { naturalShadowStage: stage, naturalShadowErrorCode: errorCode(error), ...(diagnosis ? { naturalShadowDiagnosis: diagnosis } : {}), ...(preflight ? { naturalShadowPreflight: preflight } : {}) });
  return wrapped;
}

async function observeStage<T>(telemetryState: ObserverTelemetry, stage: NaturalShadowStage, operation: () => Promise<T>, fields: Record<string, number | string> = {}): Promise<T> {
  const startedAt = Date.now();
  telemetry(telemetryState, stage, "START", fields);
  try {
    const value = await operation();
    telemetry(telemetryState, stage, "PASS", { ...fields, duration_ms: Date.now() - startedAt });
    return value;
  } catch (error) {
    telemetry(telemetryState, stage, "FAIL", { ...fields, duration_ms: Date.now() - startedAt, error_code: errorCode(error), error_class: error instanceof Error ? error.name : "NonError" });
    throw stagedError(stage, error);
  }
}

function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function toCandidate(row: SourceRow): NormalizedInboundCandidate {
  const weight = row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg);
  return {
    orderCode: String(row.order_code || ""),
    currentWarehouseId: String(row.current_warehouse_id || ""),
    deliverWarehouseId: String(row.deliver_warehouse_id || ""),
    sourceStatus: row.source_status,
    weightKg: Number.isFinite(weight) ? weight : null,
    endPickAt: row.end_pick_at,
    eta: null,
    isB2b: row.is_b2b,
    warehouseLog: [],
  };
}

async function readCompletePopulation(client: SupabaseClient, syncRunId: string, checkpointAt: string, telemetryState: ObserverTelemetry) {
  await observeStage(telemetryState, "SYNC_RUN_VALIDATION", async () => {
    const { data: syncRun, error: syncError } = await client.from("sync_runs").select("id, checkpoint_at").eq("id", syncRunId).maybeSingle();
    if (syncError || !syncRun || !syncRun.checkpoint_at || Number.isNaN(Date.parse(syncRun.checkpoint_at)) || Date.parse(syncRun.checkpoint_at) !== Date.parse(checkpointAt)) throw new Error("NATURAL_SHADOW_SYNC_RUN_IDENTITY_INVALID");
  });
  const manifest = await observeStage(telemetryState, "MANIFEST_VALIDATION", async () => {
    const { data, error } = await client.from("inbound_population_manifests").select("sync_run_id, source_system, population_status, expected_observation_count, persisted_observation_count, duplicate_conflict_count, population_completed_at, source_freshness").eq("sync_run_id", syncRunId).eq("source_system", "RILLNET").maybeSingle();
    if (error || !data || data.population_status !== "COMPLETE" || !data.population_completed_at || !data.source_freshness || data.expected_observation_count !== data.persisted_observation_count || data.duplicate_conflict_count !== 0) throw new Error("NATURAL_SHADOW_INBOUND_MANIFEST_NOT_COMPLETE");
    if (new Date(data.source_freshness).getTime() > new Date(checkpointAt).getTime()) throw new Error("NATURAL_SHADOW_FUTURE_SOURCE_DATA");
    return data;
  });
  const rows = await observeStage(telemetryState, "OBSERVATION_READ", async () => {
    const result: SourceRow[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client.from("inbound_order_observations").select("order_code, current_warehouse_id, deliver_warehouse_id, source_status, end_pick_at, weight_kg, is_b2b, source_observed_at").eq("sync_run_id", syncRunId).eq("source_system", "RILLNET").range(offset, offset + pageSize - 1);
      if (error) throw new Error(`NATURAL_SHADOW_SOURCE_READ_FAILED: ${error.message}`);
      result.push(...((data || []) as SourceRow[]));
      if (!data || data.length < pageSize) break;
    }
    return result;
  }, { expected_count: manifest.persisted_observation_count });
  await observeStage(telemetryState, "OBSERVATION_RECONCILIATION", async () => {
    if (rows.length !== manifest.persisted_observation_count) throw new Error("NATURAL_SHADOW_SOURCE_COUNT_MISMATCH");
  }, { expected_count: manifest.persisted_observation_count, actual_count: rows.length });
  return { sourceFreshness: manifest.source_freshness, manifest, rows };
}

async function resolveUniqueLeadTopics(client: SupabaseClient, telemetryState: ObserverTelemetry) {
  const selected = await observeStage(telemetryState, "ROUTING_TOPIC_RESOLUTION", async () => {
    const { data: topics, error: topicError } = await client
    .from("telegram_pilot_topics")
    .select("id, group_id, message_thread_id, topic_title, province_name, status, is_manager_decision")
    .eq("status", "ACTIVE")
    .eq("is_manager_decision", false);
    if (topicError || !topics) throw new Error("NATURAL_SHADOW_ROUTING_TOPICS_UNAVAILABLE");
    return NATURAL_SHADOW_PILOT_WAREHOUSES.map((warehouse) => {
    const resolvedProvince = resolveProvince({ warehouseId: warehouse.id, warehouse: warehouse.name });
    const matching = topics.filter((topic) => normalizeProvinceName(topic.province_name) === normalizeProvinceName(resolvedProvince));
    if (!resolvedProvince || matching.length !== 1) {
      throw new Error(`NATURAL_SHADOW_ROUTING_NOT_UNIQUE:${warehouse.id}`);
    }
    const topic = matching[0];
    const threadId = Number(topic.message_thread_id);
    if (!topic.group_id || !Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new Error(`NATURAL_SHADOW_ROUTING_INVALID:${warehouse.id}`);
    }
    return { warehouseId: warehouse.id, topicId: String(topic.id), groupId: String(topic.group_id), threadId: String(threadId) };
    });
  }, { warehouse_count: NATURAL_SHADOW_PILOT_WAREHOUSES.length });
  return observeStage(telemetryState, "ROUTING_GROUP_RESOLUTION", async () => {
    const groupIds = selected.map((item) => item.groupId);
    const { data: groups, error: groupError } = await client
    .from("telegram_pilot_groups")
    .select("id, telegram_chat_id, status")
    .in("id", groupIds)
    .eq("status", "ACTIVE");
    if (groupError || !groups) throw new Error("NATURAL_SHADOW_ROUTING_GROUPS_UNAVAILABLE");
    const groupById = new Map(groups.map((group) => [String(group.id), group]));
    return selected.map((item) => {
    const group = groupById.get(item.groupId);
    if (!group || group.telegram_chat_id === null || group.telegram_chat_id === undefined) {
      throw new Error(`NATURAL_SHADOW_ROUTING_GROUP_MISSING:${item.warehouseId}`);
    }
    return { ...item, chatId: String(group.telegram_chat_id) };
    });
  }, { warehouse_count: NATURAL_SHADOW_PILOT_WAREHOUSES.length });
}

function buildWarehouseEvidence(
  warehouse: typeof NATURAL_SHADOW_PILOT_WAREHOUSES[number],
  candidates: NormalizedInboundCandidate[],
  route: { chatId: string; threadId: string },
  sourceFreshness: string,
): ShadowWarehouseEvidence {
  const classified = classifyInboundCandidates(warehouse.id, candidates);
  const backlog = aggregateInboundBucket(classified.backlogOrders);
  const picked = aggregateInboundBucket(classified.pickedNotTransferred);
  const inTransfer = aggregateInboundBucket(classified.inTransfer);
  const pipelineOrders = classified.pickedNotTransferred.length + classified.inTransfer.length;
  const pipelineKnownKg = Math.round((picked.knownWeightKg + inTransfer.knownWeightKg) * 10) / 10;
  const pipelineUnknownWeightOrders = picked.unknownWeightOrders + inTransfer.unknownWeightOrders;
  const pipelinePressure = pipelineOrders > 50 || classified.inTransfer.length > 20
    ? "HIGH"
    : pipelineOrders > 15 || classified.inTransfer.length > 5
      ? "MEDIUM"
      : "LOW";
  const message = [
    "🚚 HÀNG ĐANG TRONG PIPELINE VỀ KHO",
    `Kho: ${warehouse.name}`,
    `Pipeline: ${pipelineOrders} đơn`,
    `Khối lượng đã biết: ${pipelineKnownKg} kg; chưa biết: ${pipelineUnknownWeightOrders} đơn`,
    "ETA: UNKNOWN",
    "[✅ Đã có phương án] [⚠️ Có ngoại lệ] [🆘 Cần hỗ trợ]",
  ].join("\n");
  return {
    warehouse_id: warehouse.id,
    warehouse_name: warehouse.name,
    backlog_orders: backlog.orderCount,
    pipeline_orders: pipelineOrders,
    pipeline_known_kg: pipelineKnownKg,
    pipeline_unknown_weight_orders: pipelineUnknownWeightOrders,
    picked_not_transferred_orders: classified.pickedNotTransferred.length,
    in_transfer_orders: classified.inTransfer.length,
    arrival_confirmed_orders: classified.arrivalConfirmed.length,
    eta_known_orders: 0,
    eta_unknown_orders: pipelineOrders,
    arrival_within_horizon_status: "UNKNOWN",
    arrival_within_horizon_orders: null,
    pipeline_pressure: pipelinePressure,
    near_term_arrival_risk: "UNKNOWN",
    routing_chat_id: route.chatId,
    routing_topic_id: route.threadId,
    source_freshness: sourceFreshness,
    shadow_message_text: message,
    shadow_message_generated: true,
  };
}

/** Natural-only observer. The caller must be the trusted follow-up scheduler. */
export async function runNaturalShadowObserver(
  client: SupabaseClient,
  input: { checkpointAt: string; syncRunId: string; trustedScheduler: true },
  telemetryState = { syncRunId: input.syncRunId, checkpointAt: input.checkpointAt, currentStage: "OBSERVER_ENTER" as NaturalShadowStage, startedAt: Date.now() },
): Promise<NaturalShadowObserverResult> {
  await observeStage(telemetryState, "OBSERVER_ENTER", async () => {
    if (input.trustedScheduler !== true) throw new Error("NATURAL_SHADOW_NOT_TRUSTED_SCHEDULER_PATH");
  });
  const { sourceFreshness, manifest, rows } = await readCompletePopulation(client, input.syncRunId, input.checkpointAt, telemetryState);
  const routes = await resolveUniqueLeadTopics(client, telemetryState);
  const candidates = rows.map(toCandidate);
  const warehouses = await observeStage(telemetryState, "WAREHOUSE_EVIDENCE_BUILD", async () => NATURAL_SHADOW_PILOT_WAREHOUSES.map((warehouse) => {
    const route = routes.find((item) => item.warehouseId === warehouse.id)!;
    return buildWarehouseEvidence(warehouse, candidates, { chatId: route.chatId, threadId: route.threadId }, sourceFreshness);
  }), { warehouse_count: NATURAL_SHADOW_PILOT_WAREHOUSES.length });

  const bundle = {
    evidence_type: "INBOUND_EVIDENCE_V2_NATURAL_SHADOW",
    observation_type: "NATURAL",
    checkpoint_at_utc: input.checkpointAt,
    checkpoint_at_local: new Date(input.checkpointAt).toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh", hour12: false }).replace(" ", "T") + "+07:00",
    timezone: "Asia/Ho_Chi_Minh",
    trigger_source: NATURAL_SHADOW_TRIGGER_SOURCE,
    authoritative_sync_run_id: input.syncRunId,
    expected_population_count: manifest.expected_observation_count,
    persisted_population_count: manifest.persisted_observation_count,
    conflict_count: manifest.duplicate_conflict_count,
    source_freshness: sourceFreshness,
    shadow_status: "COMPLETE",
    expected_warehouse_count: 3,
    persisted_warehouse_count: 3,
    v2_telegram_sent: false,
    production_flow_changed: false,
    warehouses,
  };
  const snapshot = buildNaturalShadowConstraintSnapshot({ ...bundle, manifest_status: "COMPLETE" });
  const preflight = evaluateNaturalShadowChecks(snapshot);
  try {
    logger.info({ event: "INBOUND_NATURAL_SHADOW_CONSTRAINT_SNAPSHOT", sync_run_id: input.syncRunId, checkpoint_at: input.checkpointAt, ...snapshot, ...preflight });
  } catch { /* Diagnostic telemetry cannot change observer behavior. */ }
  telemetry(telemetryState, "RPC_ATTEMPT", "START", { warehouse_count: warehouses.length });
  const rpcStartedAt = Date.now();
  let data: any;
  let error: any;
  try {
    ({ data, error } = await client.rpc("persist_inbound_evidence_v2_natural_shadow_bundle", { p_bundle: bundle }));
  } catch (caught) {
    const diagnosis = diagnoseNaturalShadowRpcError(caught);
    telemetry(telemetryState, "RPC_RESULT", "FAIL", { duration_ms: Date.now() - rpcStartedAt, ...diagnosis, ...preflight });
    throw stagedError("RPC_RESULT", caught, diagnosis, preflight);
  }
  if (error) {
    const diagnosis = diagnoseNaturalShadowRpcError(error);
    telemetry(telemetryState, "RPC_RESULT", "FAIL", { duration_ms: Date.now() - rpcStartedAt, ...diagnosis, ...preflight });
    return { status: "FAILED", reason: naturalShadowSafeFailureReason(diagnosis), warehousesEvaluated: 3, diagnosis, preflight };
  }
  const rpcResult = data?.status === "ALREADY_OBSERVED" ? "ALREADY_OBSERVED" : data?.status === "OBSERVED" ? "INSERTED" : null;
  if (rpcResult) {
    telemetry(telemetryState, "RPC_RESULT", "PASS", { duration_ms: Date.now() - rpcStartedAt, result: rpcResult });
    telemetry(telemetryState, "OBSERVER_COMPLETE", "PASS", { warehouse_count: warehouses.length, rpc_result: rpcResult, duration_ms: Date.now() - telemetryState.startedAt });
    try { logger.info({ event: "INBOUND_NATURAL_SHADOW_COMPLETE", sync_run_id: input.syncRunId, checkpoint_at: input.checkpointAt, warehouse_count: warehouses.length, rpc_result: rpcResult, duration_ms: Date.now() - telemetryState.startedAt }); } catch { /* best-effort */ }
    return rpcResult === "ALREADY_OBSERVED" ? { status: "SUCCESS_ALREADY_OBSERVED", checkpointId: data.checkpoint_id || null, warehousesEvaluated: 3 } : { status: "SUCCESS_INSERTED", checkpointId: data.checkpoint_id || null, warehousesEvaluated: 3 };
  }
  const diagnosis = unexpectedNaturalShadowRpcResultDiagnosis();
  telemetry(telemetryState, "RPC_RESULT", "FAIL", { duration_ms: Date.now() - rpcStartedAt, ...diagnosis, ...preflight });
  return { status: "FAILED", reason: "NATURAL_SHADOW_RPC_UNEXPECTED_RESULT", warehousesEvaluated: 3, diagnosis, preflight };
}

export async function runNaturalShadowObserverSafely(
  client: SupabaseClient,
  input: { checkpointAt: string; syncRunId: string; trustedScheduler: boolean },
): Promise<NaturalShadowObserverResult> {
  if (input.trustedScheduler !== true) return { status: "FAILED", reason: "NATURAL_SHADOW_NOT_TRUSTED_SCHEDULER_PATH", warehousesEvaluated: 0 };
  const telemetryState: ObserverTelemetry = { syncRunId: input.syncRunId, checkpointAt: input.checkpointAt, currentStage: "OBSERVER_ENTER", startedAt: Date.now() };
  try {
    const result = await runNaturalShadowObserver(client, { ...input, trustedScheduler: true }, telemetryState);
    if (result.status === "FAILED" && result.diagnosis) {
      try { logger.info({ event: "INBOUND_NATURAL_SHADOW_FAILURE", sync_run_id: input.syncRunId, checkpoint_at: input.checkpointAt, failed_stage: "RPC_RESULT", ...result.diagnosis, ...(result.preflight || {}) }); } catch { /* best-effort */ }
    }
    return result;
  } catch (error) {
    const staged = error as StagedNaturalShadowError;
    const diagnosis = staged.naturalShadowDiagnosis;
    const preflight = staged.naturalShadowPreflight;
    try {
      logger.info({
        event: "INBOUND_NATURAL_SHADOW_FAILURE",
        sync_run_id: input.syncRunId,
        checkpoint_at: input.checkpointAt,
        failed_stage: telemetryState.currentStage,
        ...(diagnosis || { error_class: error instanceof Error ? error.name : "NonError", sanitized_error_code: errorCode(error) }),
        ...(preflight || {}),
      });
    } catch { /* best-effort */ }
    return diagnosis
      ? { status: "FAILED", reason: naturalShadowSafeFailureReason(diagnosis), warehousesEvaluated: 0, diagnosis }
      : { status: "FAILED", reason: safeReason(error), warehousesEvaluated: 0 };
  }
}
