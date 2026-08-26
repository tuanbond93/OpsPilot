import { immutableSnapshot } from "./validation";
import type { Decision, DecisionFollowupSchedule, DecisionOutcomeObservationContract } from "./types";

export const OUTCOME_OBSERVATION_CONTRACT_VERSION = "LC05_V1" as const;
export const REQUIRED_OUTCOME_EVIDENCE_TYPES = [
  "EXECUTION_REFERENCE",
  "POST_EXECUTION_OPERATIONAL_SNAPSHOT",
] as const;

export function buildOutcomeObservationContract(input: {
  decision: Decision;
  schedule: DecisionFollowupSchedule;
  baselineEvidenceSnapshotId?: string | null;
  contractId?: string;
  createdAt?: string;
}): DecisionOutcomeObservationContract {
  const createdAt = input.createdAt || input.schedule.createdAt;
  return immutableSnapshot({
    contractId: input.contractId || crypto.randomUUID(),
    decisionId: input.decision.decisionId,
    followupScheduleId: input.schedule.scheduleId,
    baselineEvidenceSnapshotId: input.baselineEvidenceSnapshotId || null,
    baselineCapturedAt: input.decision.evidence.capturedAt,
    baselineSnapshot: input.decision.evidence,
    measurementWindowStart: input.decision.executedAt || input.schedule.createdAt,
    measurementWindowEnd: input.schedule.checkAt,
    requiredEvidenceTypes: REQUIRED_OUTCOME_EVIDENCE_TYPES,
    contractVersion: OUTCOME_OBSERVATION_CONTRACT_VERSION,
    createdAt,
  });
}
