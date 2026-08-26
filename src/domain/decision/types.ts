export type DecisionMode = "SHADOW" | "HUMAN_APPROVAL" | "AUTONOMOUS";

export type DecisionStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTED"
  | "OUTCOME_PENDING"
  | "SUCCESS"
  | "FAILURE"
  | "INCONCLUSIVE";

export type DecisionRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DecisionOutcomeStatus = "SUCCESS" | "FAILURE" | "INCONCLUSIVE";
export type DecisionFollowupScheduleStatus = "SCHEDULED";

export interface DecisionFollowupSchedule {
  scheduleId: string;
  decisionId: string;
  executionAuditEventId: string;
  status: DecisionFollowupScheduleStatus;
  checkAt: string;
  policyVersion: "LC04_V1";
  riskLevelAtSchedule: DecisionRiskLevel;
  scheduledBy: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface DecisionOutcomeObservationContract {
  contractId: string;
  decisionId: string;
  followupScheduleId: string;
  baselineEvidenceSnapshotId?: string | null;
  baselineCapturedAt: string;
  baselineSnapshot: DecisionEvidenceSnapshot;
  measurementWindowStart: string;
  measurementWindowEnd: string;
  requiredEvidenceTypes: readonly string[];
  contractVersion: "LC05_V1";
  createdAt: string;
}

export type OutcomeVerificationReasonCode = "SUCCESS_RESOLVED" | "FAILURE_NO_IMPROVEMENT" | "INCONCLUSIVE_PARTIAL_IMPROVEMENT" | "INCONCLUSIVE_METRIC_UNAVAILABLE";

export interface DecisionOutcomeVerification {
  verificationId: string;
  decisionId: string;
  contractId: string;
  classification: DecisionOutcomeStatus;
  reasonCode: OutcomeVerificationReasonCode;
  baselineAffectedOrders?: number | null;
  observedAffectedOrders?: number | null;
  observedMetrics: Readonly<Record<string, unknown>>;
  observedAt: string;
  source: string;
  evidenceRefs: string[];
  verifiedBy: string;
  createdAt: string;
}

export interface DecisionSourceLinks {
  incidentId?: string;
  rootCauseRunId?: string;
  followupCaseId?: string;
  actionId?: string;
  plannerRunId?: string;
  sourceType: string;
  sourceId: string;
}

export interface DecisionEvidenceSnapshot {
  sourceIdentifiers: Record<string, string>;
  signalContext?: Record<string, unknown>;
  rootCauseContext?: Record<string, unknown>;
  actionContext?: Record<string, unknown>;
  operationalFacts: Record<string, unknown>;
  capturedAt: string;
}

export interface Decision {
  decisionId: string;
  sourceLinks: DecisionSourceLinks;
  sourceFingerprint: string;
  idempotencyKey: string;
  problem: string;
  rootCause: string;
  recommendedAction: string;
  alternatives: string[];
  evidence: DecisionEvidenceSnapshot;
  confidence: number;
  riskLevel: DecisionRiskLevel;
  decisionStatus: DecisionStatus;
  mode: DecisionMode;
  financialImpact: { status: "NOT_EVALUATED" };
  createdAt: string;
  updatedAt: string;
  decisionDeadline?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: string | null;
  rejectedAt?: string | null;
  rejectReason?: string | null;
  executedBy?: string | null;
  executedAt?: string | null;
  executionReference?: string | null;
  outcomeStatus?: DecisionOutcomeStatus | null;
  outcomeRecordedAt?: string | null;
  followupSchedule?: DecisionFollowupSchedule | null;
  outcomeObservationContract?: DecisionOutcomeObservationContract | null;
}

export interface DecisionAuditEvent {
  eventId: string;
  decisionId: string;
  idempotencyKey: string;
  actor: string;
  occurredAt: string;
  previousStatus: DecisionStatus | null;
  newStatus: DecisionStatus;
  metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionOutcomeRecord {
  outcomeId: string;
  decisionId: string;
  status: DecisionOutcomeStatus;
  observedOutcome: string;
  measuredAt: string;
  evidenceRefs: string[];
  inconclusiveReason?: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface CreateDecisionInput {
  sourceLinks: DecisionSourceLinks;
  sourceFingerprint: string;
  idempotencyKey: string;
  problem: string;
  rootCause: string;
  recommendedAction: string;
  alternatives?: string[];
  evidence: Omit<DecisionEvidenceSnapshot, "capturedAt"> & { capturedAt?: string };
  confidence: number;
  riskLevel: DecisionRiskLevel;
  mode: DecisionMode;
  decisionDeadline?: string | null;
  actor: string;
}

export interface TransitionDecisionInput {
  decisionId: string;
  targetStatus: DecisionStatus;
  actor: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  rejectReason?: string;
  executionReference?: string;
}

export interface RecordOutcomeInput {
  decisionId: string;
  status: DecisionOutcomeStatus;
  observedOutcome: string;
  measuredAt: string;
  evidenceRefs?: string[];
  inconclusiveReason?: string;
  actor: string;
  idempotencyKey: string;
}

export interface RecordDecisionExecutionInput {
  decisionId: string;
  actor: string;
  idempotencyKey: string;
  executionReference: string;
  performedAt?: string;
  note?: string;
}

export interface VerifyDecisionOutcomeInput {
  decisionId: string;
  observedAt: string;
  source: string;
  observedMetrics: { affectedOrders?: number };
  evidenceRefs: string[];
  actor: string;
  idempotencyKey: string;
}
