import type {
  CreateDecisionInput,
  Decision,
  DecisionAuditEvent,
  DecisionFollowupSchedule,
  DecisionOutcomeObservationContract,
  DecisionOutcomeRecord,
  RecordOutcomeInput,
  TransitionDecisionInput,
} from "@/domain/decision";

export interface DecisionMutationResult {
  decision: Decision;
  idempotent: boolean;
}

export interface IDecisionRepository {
  create(input: CreateDecisionInput): Promise<DecisionMutationResult>;
  getById(decisionId: string): Promise<Decision | null>;
  list(limit?: number): Promise<Decision[]>;
  transition(input: TransitionDecisionInput): Promise<DecisionMutationResult>;
  recordOutcome(input: RecordOutcomeInput): Promise<DecisionMutationResult>;
  getAuditEvents(decisionId: string): Promise<readonly DecisionAuditEvent[]>;
  getOutcomes(decisionId: string): Promise<readonly DecisionOutcomeRecord[]>;
  getFollowupSchedules(decisionId: string): Promise<readonly DecisionFollowupSchedule[]>;
  getOutcomeObservationContract(decisionId: string): Promise<DecisionOutcomeObservationContract | null>;
}
