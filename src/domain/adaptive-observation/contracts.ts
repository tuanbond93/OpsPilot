/** Versioned, append-only shadow evidence contracts. No operational dependency is permitted here. */
export const ADAPTIVE_OBSERVATION_SCHEMA_VERSION = "v0";
export type EvidenceConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type SlaState = "KNOWN" | "UNKNOWN" | "AMBIGUOUS";
export type EtaLevel = "TRUSTED_OPERATIONAL" | "STRUCTURED_OPERATOR" | "DERIVED" | "WEAK" | "UNKNOWN";
export type ProgressState = "NO_PROGRESS" | "ROUTE_ASSIGNED" | "DRIVER_ASSIGNED" | "IN_PROGRESS" | "DELIVERY_ATTEMPTED" | "FAILED" | "COMPLETED" | "UNKNOWN";
export type CommitmentState = "NONE" | "ACTIVE" | "EXPIRED" | "COMPLETED" | "AMBIGUOUS" | "UNKNOWN";
export type EmployeeResponseType = "DONE" | "IN_PROGRESS" | "CANNOT_COMPLETE" | "INFORMATION_INCORRECT";
export type CannotCompleteReason = "CUSTOMER_APPOINTMENT" | "MISSING_PACKAGE" | "MISSING_DOCUMENT" | "DAMAGED" | "NO_VEHICLE" | "OTHER";

export interface AdaptiveObservationSnapshot {
  snapshotId: string; caseId: string; incidentId: string; observedAt: string; trigger: string; schemaVersion: typeof ADAPTIVE_OBSERVATION_SCHEMA_VERSION;
  scope: { region: string | null; province: string | null; warehouse: string | null; issueType: string | null };
  incident: { currentState: string | null; resolutionState: "ACTIVE" | "RESOLVED" | "UNKNOWN"; resolvedAt: string | null };
  backlog: { currentAffectedOrders: number | null; previousAffectedOrders: number | null; trend: "NEW" | "INCREASED" | "DECREASED" | "UNCHANGED" | "RESOLVED" | "REOPENED" | "UNKNOWN"; backlogAgeMinutes: number | null; meaningfulProgress: boolean | null };
  progress: { routeAssigned: boolean | null; driverAssigned: boolean | null; deliveryStarted: boolean | null; latestOperationalEventAt: string | null; progressState: ProgressState };
  sla: { state: SlaState; requiredBy: string | null; source: string | null; evidenceLevel: string | null; confidence: EvidenceConfidence };
  eta: { eta: string | null; source: string | null; evidenceLevel: EtaLevel; confidence: EvidenceConfidence; expired: boolean | null };
  exception: { state: "ACTIVE" | "EXPIRED" | "NONE" | "UNKNOWN"; type: string | null; source: string | null; createdAt: string | null; expiresAt: string | null; confidence: EvidenceConfidence };
  commitment: { state: CommitmentState; actor: string | null; committedAt: string | null; committedCompletionAt: string | null; source: string | null; confidence: EvidenceConfidence };
  interventions: { lastConfirmedInterventionType: string | null; lastConfirmedInterventionAt: string | null; interventionsToday: number | null; lastRecipient: string | null; operatorRespondedAfterLastIntervention: boolean | null };
  operatorResponse: { respondedAt: string | null; responseCode: string | null; structuredReason: string | null; actor: string | null; updateId: string | null; confidence: EvidenceConfidence };
  evidenceQuality: { completeness: EvidenceConfidence; missingFields: string[]; ambiguousFields: string[]; staleFields: string[] };
}

export interface CheckpointCaseSnapshot {
  checkpointId: string; checkpointAt: string; caseId: string; engineMember: boolean | null; telegramStatusMember: boolean | null; dashboardMember: boolean | null;
  region: string | null; province: string | null; warehouse: string | null; incidentState: string | null; affectedOrderCount: number | null; schemaVersion: typeof ADAPTIVE_OBSERVATION_SCHEMA_VERSION;
}

export interface AdaptiveShadowDecisionRecord {
  shadowDecisionId: string; snapshotId: string; caseId: string; observedAt: string; engineVersion: string; policyVersion: string;
  v1Decision: string; v2Decision: string; risk: string; confidence: EvidenceConfidence; reasonCode: string; humanReason: string; target: string; nextCheckAt: string | null; evidenceCompleteness: EvidenceConfidence; comparisonClass: string;
}

export interface ShadowOutcomeObservation { shadowDecisionId: string; observedAt: string; outcomeType: "RESOLVED" | "PROGRESS_OBSERVED" | "OPERATOR_RESPONDED" | "SLA_MISSED" | "ESCALATED" | "NO_CHANGE" | "UNKNOWN"; evidence: string[]; confidence: EvidenceConfidence; }

export type EmployeeResponse = { type: "DONE" | "INFORMATION_INCORRECT" } | { type: "IN_PROGRESS"; expectedCompletionAt?: string | null } | { type: "CANNOT_COMPLETE"; reason: CannotCompleteReason };

export interface ShadowFeatureFlags { ADAPTIVE_V2_SHADOW_ENABLED: boolean; SHADOW_SNAPSHOT_WRITE_ENABLED: boolean; }

export const DEFAULT_SHADOW_FEATURE_FLAGS: ShadowFeatureFlags = { ADAPTIVE_V2_SHADOW_ENABLED: false, SHADOW_SNAPSHOT_WRITE_ENABLED: false };
