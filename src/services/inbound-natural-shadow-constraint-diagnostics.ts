const CHECKPOINT_RELATION = "inbound_evidence_v2_natural_shadow_checkpoints";
const WAREHOUSE_RELATION = "inbound_evidence_v2_natural_shadow_warehouses";
const NOT_AVAILABLE = "NOT_AVAILABLE";

// These are the PostgreSQL-generated names for the applied 087 CHECK contract,
// plus its explicitly named composite horizon check.  This is deliberately a
// closed set: provider text can never introduce a new identifier into telemetry.
export const NATURAL_SHADOW_CHECK_CONSTRAINTS = [
  "inbound_evidence_v2_natural_shadow_checkpoints_evidence_type_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_observation_type_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_checkpoint_at_local_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_timezone_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_trigger_source_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_manifest_status_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_expected_population_count_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_persisted_population_count_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_conflict_count_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_shadow_status_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_expected_warehouse_count_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_persisted_warehouse_count_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_v2_telegram_sent_check",
  "inbound_evidence_v2_natural_shadow_checkpoints_production_flow_changed_check",
  "inbound_evidence_v2_natural_shadow_warehouses_warehouse_id_check",
  "inbound_evidence_v2_natural_shadow_warehouses_warehouse_name_check",
  "inbound_evidence_v2_natural_shadow_warehouses_backlog_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_pipeline_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_pipeline_known_kg_check",
  "inbound_evidence_v2_natural_shadow_warehouses_pipeline_unknown_weight_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_picked_not_transferred_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_in_transfer_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_arrival_confirmed_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_eta_known_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_eta_unknown_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_arrival_within_horizon_status_check",
  "inbound_evidence_v2_natural_shadow_warehouses_arrival_within_horizon_orders_check",
  "inbound_evidence_v2_natural_shadow_warehouses_pipeline_pressure_check",
  "inbound_evidence_v2_natural_shadow_warehouses_near_term_arrival_risk_check",
  "inbound_evidence_v2_natural_shadow_warehouses_shadow_message_text_check",
  "inbound_evidence_v2_natural_shadow_warehouses_shadow_message_generated_check",
  "ck_inbound_evidence_v2_unknown_horizon",
] as const;

const ALLOWED_CONSTRAINTS = new Set<string>(NATURAL_SHADOW_CHECK_CONSTRAINTS);
const ALLOWED_RELATIONS = new Set([CHECKPOINT_RELATION, WAREHOUSE_RELATION]);

export type NaturalShadowConstraintSnapshot = {
  parent: {
    evidence_type: string; observation_type: string; checkpoint_at_local: string; timezone: string; trigger_source: string;
    manifest_status: string; expected_population_count: number; persisted_population_count: number; conflict_count: number;
    shadow_status: string; expected_warehouse_count: number; persisted_warehouse_count: number;
    v2_telegram_sent: boolean; production_flow_changed: boolean;
  };
  warehouses: Array<{
    warehouse_id: string; backlog_orders: number; pipeline_orders: number; pipeline_known_kg: number | null;
    pipeline_unknown_weight_orders: number; picked_not_transferred_orders: number; in_transfer_orders: number;
    arrival_confirmed_orders: number; eta_known_orders: number; eta_unknown_orders: number;
    arrival_within_horizon_status: string; arrival_within_horizon_orders: number | null; pipeline_pressure: string;
    near_term_arrival_risk: string; shadow_message_generated: boolean; warehouse_name_nonempty: boolean;
    shadow_message_length: number; routing_chat_id_present: boolean; routing_topic_id_present: boolean;
  }>;
};

type SnapshotInput = NaturalShadowConstraintSnapshot["parent"] & {
  warehouses: Array<{
    warehouse_id: string; warehouse_name: string; backlog_orders: number; pipeline_orders: number; pipeline_known_kg: number | null;
    pipeline_unknown_weight_orders: number; picked_not_transferred_orders: number; in_transfer_orders: number;
    arrival_confirmed_orders: number; eta_known_orders: number; eta_unknown_orders: number;
    arrival_within_horizon_status: string; arrival_within_horizon_orders: number | null; pipeline_pressure: string;
    near_term_arrival_risk: string; shadow_message_generated: boolean; shadow_message_text: string;
    routing_chat_id: string | null; routing_topic_id: string | null;
  }>;
};

export function buildNaturalShadowConstraintSnapshot(input: SnapshotInput): NaturalShadowConstraintSnapshot {
  const { warehouses, ...parent } = input;
  return {
    parent,
    warehouses: warehouses.map((warehouse) => ({
      warehouse_id: warehouse.warehouse_id,
      backlog_orders: warehouse.backlog_orders,
      pipeline_orders: warehouse.pipeline_orders,
      pipeline_known_kg: warehouse.pipeline_known_kg,
      pipeline_unknown_weight_orders: warehouse.pipeline_unknown_weight_orders,
      picked_not_transferred_orders: warehouse.picked_not_transferred_orders,
      in_transfer_orders: warehouse.in_transfer_orders,
      arrival_confirmed_orders: warehouse.arrival_confirmed_orders,
      eta_known_orders: warehouse.eta_known_orders,
      eta_unknown_orders: warehouse.eta_unknown_orders,
      arrival_within_horizon_status: warehouse.arrival_within_horizon_status,
      arrival_within_horizon_orders: warehouse.arrival_within_horizon_orders,
      pipeline_pressure: warehouse.pipeline_pressure,
      near_term_arrival_risk: warehouse.near_term_arrival_risk,
      shadow_message_generated: warehouse.shadow_message_generated,
      warehouse_name_nonempty: warehouse.warehouse_name.trim().length > 0,
      shadow_message_length: warehouse.shadow_message_text.length,
      routing_chat_id_present: Boolean(warehouse.routing_chat_id),
      routing_topic_id_present: Boolean(warehouse.routing_topic_id),
    })),
  };
}

export type LocalCheckPreflight = { local_check_preflight: "PASS" | "FAIL"; local_failed_constraint: string };
const checkpointConstraint = (column: string) => `${CHECKPOINT_RELATION}_${column}_check`;
const warehouseConstraint = (column: string) => `${WAREHOUSE_RELATION}_${column}_check`;
const nonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonNegativeInteger = (value: unknown) => Number.isInteger(value) && nonNegative(value);

export function evaluateNaturalShadowChecks(snapshot: NaturalShadowConstraintSnapshot): LocalCheckPreflight {
  const p = snapshot.parent;
  const fail = (constraint: string): LocalCheckPreflight => ({ local_check_preflight: "FAIL", local_failed_constraint: constraint });
  if (p.evidence_type !== "INBOUND_EVIDENCE_V2_NATURAL_SHADOW") return fail(checkpointConstraint("evidence_type"));
  if (p.observation_type !== "NATURAL") return fail(checkpointConstraint("observation_type"));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+07:00$/.test(p.checkpoint_at_local)) return fail(checkpointConstraint("checkpoint_at_local"));
  if (p.timezone !== "Asia/Ho_Chi_Minh") return fail(checkpointConstraint("timezone"));
  if (!p.trigger_source.trim()) return fail(checkpointConstraint("trigger_source"));
  if (p.manifest_status !== "COMPLETE") return fail(checkpointConstraint("manifest_status"));
  if (!nonNegativeInteger(p.expected_population_count)) return fail(checkpointConstraint("expected_population_count"));
  if (!nonNegativeInteger(p.persisted_population_count)) return fail(checkpointConstraint("persisted_population_count"));
  if (p.conflict_count !== 0) return fail(checkpointConstraint("conflict_count"));
  if (!(["STARTED", "COMPLETE", "INCOMPLETE", "FAILED"] as string[]).includes(p.shadow_status)) return fail(checkpointConstraint("shadow_status"));
  if (p.expected_warehouse_count !== 3) return fail(checkpointConstraint("expected_warehouse_count"));
  if (!nonNegativeInteger(p.persisted_warehouse_count) || p.persisted_warehouse_count > 3) return fail(checkpointConstraint("persisted_warehouse_count"));
  if (p.v2_telegram_sent !== false) return fail(checkpointConstraint("v2_telegram_sent"));
  if (p.production_flow_changed !== false) return fail(checkpointConstraint("production_flow_changed"));
  for (const w of snapshot.warehouses) {
    if (!(["21161000", "21158000", "21160000"] as string[]).includes(w.warehouse_id)) return fail(warehouseConstraint("warehouse_id"));
    if (!w.warehouse_name_nonempty) return fail(warehouseConstraint("warehouse_name"));
    const counts: Array<[keyof typeof w, string]> = [
      ["backlog_orders", "backlog_orders"], ["pipeline_orders", "pipeline_orders"], ["pipeline_unknown_weight_orders", "pipeline_unknown_weight_orders"],
      ["picked_not_transferred_orders", "picked_not_transferred_orders"], ["in_transfer_orders", "in_transfer_orders"], ["arrival_confirmed_orders", "arrival_confirmed_orders"],
      ["eta_known_orders", "eta_known_orders"], ["eta_unknown_orders", "eta_unknown_orders"],
    ];
    for (const [field, column] of counts) if (!nonNegativeInteger(w[field])) return fail(warehouseConstraint(column));
    if (w.pipeline_known_kg !== null && !nonNegative(w.pipeline_known_kg)) return fail(warehouseConstraint("pipeline_known_kg"));
    if (!(["UNKNOWN", "KNOWN"] as string[]).includes(w.arrival_within_horizon_status)) return fail(warehouseConstraint("arrival_within_horizon_status"));
    if (w.arrival_within_horizon_orders !== null && !nonNegativeInteger(w.arrival_within_horizon_orders)) return fail(warehouseConstraint("arrival_within_horizon_orders"));
    if (!(["UNKNOWN", "LOW", "MEDIUM", "HIGH"] as string[]).includes(w.pipeline_pressure)) return fail(warehouseConstraint("pipeline_pressure"));
    if (!(["UNKNOWN", "LOW", "MEDIUM", "HIGH"] as string[]).includes(w.near_term_arrival_risk)) return fail(warehouseConstraint("near_term_arrival_risk"));
    if (!Number.isInteger(w.shadow_message_length) || w.shadow_message_length <= 0) return fail(warehouseConstraint("shadow_message_text"));
    if (w.shadow_message_generated !== true) return fail(warehouseConstraint("shadow_message_generated"));
    if ((w.arrival_within_horizon_status === "UNKNOWN" && w.arrival_within_horizon_orders !== null) || (w.arrival_within_horizon_status === "KNOWN" && w.arrival_within_horizon_orders === null)) return fail("ck_inbound_evidence_v2_unknown_horizon");
  }
  return { local_check_preflight: "PASS", local_failed_constraint: NOT_AVAILABLE };
}

function candidateFrom(text: unknown, expression: RegExp): string | undefined {
  if (typeof text !== "string") return undefined;
  const value = text.match(expression)?.[1];
  return value && /^[a-z_][a-z0-9_]{0,127}$/.test(value) ? value : undefined;
}

/** Reads provider text only transiently, returning identifiers from the closed allowlists. */
export function extractNaturalShadowConstraintError(error: Record<string, unknown>) {
  const fields = [error.message, error.details, error.hint];
  const constraint = fields.map((value) => candidateFrom(value, /(?:violates|constraint)\s+(?:check\s+)?constraint\s+"([a-zA-Z_][a-zA-Z0-9_]*)"/i)).find((value) => value !== undefined);
  const relation = fields.map((value) => candidateFrom(value, /(?:relation|table)\s+"([a-zA-Z_][a-zA-Z0-9_]*)"/i)).find((value) => value !== undefined);
  return {
    constraint_identifier: constraint && ALLOWED_CONSTRAINTS.has(constraint) ? constraint : NOT_AVAILABLE,
    constraint_relation: relation && ALLOWED_RELATIONS.has(relation) ? relation : NOT_AVAILABLE,
  };
}
