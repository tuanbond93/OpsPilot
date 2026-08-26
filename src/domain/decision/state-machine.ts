import type { DecisionStatus } from "./types";

const ALLOWED_TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  DRAFT: ["READY_FOR_REVIEW"],
  READY_FOR_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["EXECUTED"],
  REJECTED: [],
  EXECUTED: ["OUTCOME_PENDING"],
  OUTCOME_PENDING: ["SUCCESS", "FAILURE", "INCONCLUSIVE"],
  SUCCESS: [],
  FAILURE: [],
  INCONCLUSIVE: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertDecisionTransition(from: DecisionStatus, to: DecisionStatus): void {
  if (!canTransition(from, to)) {
    throw new DecisionDomainError("INVALID_TRANSITION", `Decision cannot transition from ${from} to ${to}.`);
  }
}

export class DecisionDomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DecisionDomainError";
  }
}
