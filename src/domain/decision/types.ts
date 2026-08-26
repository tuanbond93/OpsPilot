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
