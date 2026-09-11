import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdaptiveObservationSnapshot, AdaptiveShadowDecisionRecord, CheckpointCaseSnapshot, ShadowOutcomeObservation } from "./contracts";

type InsertClient = Pick<SupabaseClient, "from">;
const requireValue = (value: unknown, name: string) => { if (value === null || value === undefined || value === "") throw new Error(`INVALID_SHADOW_CONTRACT:${name}`); };
const key = (prefix: string, values: string[]) => `${prefix}:${values.join(":")}`;

/** Insert-only store boundary. It exposes no update/delete/operational methods. */
export class AdaptiveObservationWriter {
  constructor(private readonly client: InsertClient) {}
  async appendSnapshot(snapshot: AdaptiveObservationSnapshot): Promise<string> {
    requireValue(snapshot.snapshotId, "snapshotId"); requireValue(snapshot.caseId, "caseId"); requireValue(snapshot.incidentId, "incidentId");
    const { data, error } = await (this.client.from("adaptive_observation_snapshots") as any).insert({ idempotency_key: key("snapshot", [snapshot.snapshotId]), case_id: snapshot.caseId, incident_id: snapshot.incidentId, observed_at: snapshot.observedAt, trigger: snapshot.trigger, schema_version: snapshot.schemaVersion, snapshot }).select("id").single();
    if (error) throw error; return data.id;
  }
  async appendCheckpointPopulation(snapshot: CheckpointCaseSnapshot): Promise<string> {
    requireValue(snapshot.checkpointId, "checkpointId"); requireValue(snapshot.caseId, "caseId");
    const { data, error } = await (this.client.from("checkpoint_case_snapshots") as any).insert({ idempotency_key: key("population", [snapshot.checkpointId, snapshot.caseId]), checkpoint_id: snapshot.checkpointId, checkpoint_at: snapshot.checkpointAt, case_id: snapshot.caseId, engine_member: snapshot.engineMember, telegram_status_member: snapshot.telegramStatusMember, dashboard_member: snapshot.dashboardMember, region: snapshot.region, province: snapshot.province, warehouse: snapshot.warehouse, incident_state: snapshot.incidentState, affected_order_count: snapshot.affectedOrderCount, schema_version: snapshot.schemaVersion }).select("id").single();
    if (error) throw error; return data.id;
  }
  async appendShadowDecision(decision: AdaptiveShadowDecisionRecord, persistedSnapshotId: string): Promise<string> {
    requireValue(persistedSnapshotId, "persistedSnapshotId"); requireValue(decision.snapshotId, "snapshotId");
    const { data, error } = await (this.client.from("adaptive_shadow_decisions") as any).insert({ idempotency_key: key("decision", [decision.shadowDecisionId]), snapshot_id: persistedSnapshotId, case_id: decision.caseId, observed_at: decision.observedAt, engine_version: decision.engineVersion, policy_version: decision.policyVersion, v1_decision: decision.v1Decision, v2_decision: decision.v2Decision, risk: decision.risk, confidence: decision.confidence, reason_code: decision.reasonCode, human_reason: decision.humanReason, target: decision.target, next_check_at: decision.nextCheckAt, evidence_completeness: decision.evidenceCompleteness, comparison_class: decision.comparisonClass }).select("id").single();
    if (error) throw error; return data.id;
  }
  async appendOutcomeObservation(outcome: ShadowOutcomeObservation, persistedDecisionId: string): Promise<string> {
    requireValue(persistedDecisionId, "persistedDecisionId");
    const { data, error } = await (this.client.from("shadow_outcome_observations") as any).insert({ idempotency_key: key("outcome", [outcome.shadowDecisionId, outcome.observedAt, outcome.outcomeType]), shadow_decision_id: persistedDecisionId, observed_at: outcome.observedAt, outcome_type: outcome.outcomeType, evidence: outcome.evidence, confidence: outcome.confidence }).select("id").single();
    if (error) throw error; return data.id;
  }
}
