import type { CreateDecisionInput, RecordDecisionExecutionInput, RecordOutcomeInput, TransitionDecisionInput, VerifyDecisionOutcomeInput } from "@/domain/decision";

export interface DecisionServiceResult<T = unknown> {
  ok: boolean;
  data?: T;
  idempotent?: boolean;
  error?: string;
  message?: string;
}

export interface IDecisionService {
  create(input: CreateDecisionInput): Promise<DecisionServiceResult>;
  list(limit?: number): Promise<DecisionServiceResult>;
  get(decisionId: string): Promise<DecisionServiceResult>;
  transition(input: TransitionDecisionInput): Promise<DecisionServiceResult>;
  recordExecution(input: RecordDecisionExecutionInput): Promise<DecisionServiceResult>;
  recordOutcome(input: RecordOutcomeInput): Promise<DecisionServiceResult>;
  verifyOutcome(input: VerifyDecisionOutcomeInput): Promise<DecisionServiceResult>;
  getMemory(decisionId: string, limit?: number): Promise<DecisionServiceResult>;
}
