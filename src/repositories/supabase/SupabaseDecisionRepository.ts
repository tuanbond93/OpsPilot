import type { SupabaseClient } from "@supabase/supabase-js";
import type { IDecisionRepository, DecisionMutationResult } from "../interfaces/IDecisionRepository";
import type { CreateDecisionInput, Decision, DecisionAuditEvent, DecisionEvidenceSnapshot, DecisionFollowupSchedule, DecisionOutcomeObservationContract, DecisionOutcomeRecord, DecisionOutcomeVerification, RecordOutcomeInput, TransitionDecisionInput, VerifyDecisionOutcomeInput } from "@/domain/decision";

type DbRow = Record<string, any>;

function mapDecision(row: DbRow, evidence?: DecisionEvidenceSnapshot): Decision {
  const scheduleRow = row.decision_followup_schedules?.[0];
  const contractRow = row.decision_outcome_observation_contracts?.[0];
  return {
    decisionId: row.id, sourceLinks: row.source_links, sourceFingerprint: row.source_fingerprint,
    idempotencyKey: row.idempotency_key, problem: row.problem, rootCause: row.root_cause,
    recommendedAction: row.recommended_action, alternatives: row.alternatives || [], evidence: evidence || row.evidence,
    confidence: Number(row.confidence), riskLevel: row.risk_level, decisionStatus: row.decision_status,
    mode: row.decision_mode, financialImpact: { status: "NOT_EVALUATED" }, createdAt: row.created_at,
    updatedAt: row.updated_at, decisionDeadline: row.decision_deadline, approvedBy: row.approved_by,
    approvedAt: row.approved_at, rejectedBy: row.rejected_by, rejectedAt: row.rejected_at,
    rejectReason: row.reject_reason, executedBy: row.executed_by, executedAt: row.executed_at,
    executionReference: row.execution_reference, outcomeStatus: row.outcome_status, outcomeRecordedAt: row.outcome_recorded_at,
    followupSchedule: scheduleRow ? mapFollowupSchedule(scheduleRow) : null,
    outcomeObservationContract: contractRow ? mapOutcomeObservationContract(contractRow) : null,
  };
}

function mapFollowupSchedule(row: DbRow): DecisionFollowupSchedule {
  return {
    scheduleId: row.id, decisionId: row.decision_id, executionAuditEventId: row.execution_audit_event_id,
    status: row.status, checkAt: row.check_at, policyVersion: row.policy_version,
    riskLevelAtSchedule: row.risk_level_at_schedule, scheduledBy: row.scheduled_by,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at,
  };
}

function mapOutcomeObservationContract(row: DbRow): DecisionOutcomeObservationContract {
  return {
    contractId: row.id, decisionId: row.decision_id, followupScheduleId: row.followup_schedule_id,
    baselineEvidenceSnapshotId: row.baseline_evidence_snapshot_id, baselineCapturedAt: row.baseline_captured_at,
    baselineSnapshot: row.baseline_snapshot, measurementWindowStart: row.measurement_window_start,
    measurementWindowEnd: row.measurement_window_end, requiredEvidenceTypes: row.required_evidence_types,
    contractVersion: row.contract_version, createdAt: row.created_at,
  };
}

const DECISION_SELECT = "*, decision_evidence_snapshots(snapshot), decision_followup_schedules(*), decision_outcome_observation_contracts(*)";

export class SupabaseDecisionRepository implements IDecisionRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc(name: string, input: unknown): Promise<DecisionMutationResult> {
    const { data, error } = await this.client.rpc(name, { p_payload: input });
    if (error) throw error;
    return { decision: mapDecision(data.decision), idempotent: Boolean(data.idempotent) };
  }

  async create(input: CreateDecisionInput) {
    const result = await this.rpc("create_decision_core", input);
    return { ...result, decision: { ...result.decision, evidence: { ...input.evidence, capturedAt: input.evidence.capturedAt || result.decision.createdAt } } };
  }

  async getById(decisionId: string): Promise<Decision | null> {
    const { data, error } = await this.client.from("decisions").select(DECISION_SELECT).eq("id", decisionId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const snapshot = data.decision_evidence_snapshots?.[0]?.snapshot;
    return mapDecision(data, snapshot);
  }

  async list(limit = 100): Promise<Decision[]> {
    const { data, error } = await this.client.from("decisions").select(DECISION_SELECT).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map((row) => mapDecision(row, row.decision_evidence_snapshots?.[0]?.snapshot));
  }

  transition(input: TransitionDecisionInput) { return this.rpc("transition_decision_core", input); }
  recordOutcome(input: RecordOutcomeInput) { return this.rpc("record_decision_outcome", input); }

  async getAuditEvents(decisionId: string): Promise<readonly DecisionAuditEvent[]> {
    const { data, error } = await this.client.from("decision_audit_events").select("*").eq("decision_id", decisionId).order("occurred_at");
    if (error) throw error;
    return (data || []).map((row) => ({ eventId: row.id, decisionId: row.decision_id, idempotencyKey: row.idempotency_key,
      actor: row.actor, occurredAt: row.occurred_at, previousStatus: row.previous_status, newStatus: row.new_status, metadata: row.metadata }));
  }

  async getOutcomes(decisionId: string): Promise<readonly DecisionOutcomeRecord[]> {
    const { data, error } = await this.client.from("decision_outcomes").select("*").eq("decision_id", decisionId).order("recorded_at");
    if (error) throw error;
    return (data || []).map((row) => ({ outcomeId: row.id, decisionId: row.decision_id, status: row.status,
      observedOutcome: row.observed_outcome, measuredAt: row.measured_at, evidenceRefs: row.evidence_refs,
      inconclusiveReason: row.inconclusive_reason, recordedBy: row.recorded_by, recordedAt: row.recorded_at }));
  }

  async getFollowupSchedules(decisionId: string): Promise<readonly DecisionFollowupSchedule[]> {
    const { data, error } = await this.client.from("decision_followup_schedules").select("*").eq("decision_id", decisionId).order("created_at");
    if (error) throw error;
    return (data || []).map(mapFollowupSchedule);
  }

  async getOutcomeObservationContract(decisionId: string): Promise<DecisionOutcomeObservationContract | null> {
    const { data, error } = await this.client.from("decision_outcome_observation_contracts").select("*").eq("decision_id", decisionId).maybeSingle();
    if (error) throw error;
    return data ? mapOutcomeObservationContract(data) : null;
  }

  recordVerifiedOutcome(input: VerifyDecisionOutcomeInput & { verification: Omit<DecisionOutcomeVerification, "verificationId" | "createdAt">; observedOutcome: string; inconclusiveReason?: string }) {
    return this.rpc("record_verified_decision_outcome", input);
  }

  async getOutcomeVerifications(decisionId: string): Promise<readonly DecisionOutcomeVerification[]> {
    const { data, error } = await this.client.from("decision_outcome_verifications").select("*").eq("decision_id", decisionId).order("created_at");
    if (error) throw error;
    return (data || []).map((row) => ({ verificationId: row.id, decisionId: row.decision_id, contractId: row.contract_id,
      classification: row.classification, reasonCode: row.reason_code, baselineAffectedOrders: row.baseline_affected_orders,
      observedAffectedOrders: row.observed_affected_orders, observedMetrics: row.observed_metrics, observedAt: row.observed_at,
      source: row.source, evidenceRefs: row.evidence_refs, verifiedBy: row.verified_by, createdAt: row.created_at }));
  }
}
