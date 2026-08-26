import { DecisionDomainError } from "./state-machine";
import type { CreateDecisionInput, DecisionMode, DecisionOutcomeStatus, DecisionRiskLevel, DecisionStatus, RecordDecisionExecutionInput, RecordOutcomeInput, TransitionDecisionInput } from "./types";

const MAX_TEXT = 10_000;
const MAX_ACTOR = 200;

export function requireText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DecisionDomainError("VALIDATION_ERROR", `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new DecisionDomainError("VALIDATION_ERROR", `${field} is too long.`);
  return trimmed;
}

export function validateActor(actor: unknown): string {
  return requireText(actor, "actor", MAX_ACTOR);
}

export function assertModeAllowed(mode: DecisionMode): void {
  if (!["SHADOW", "HUMAN_APPROVAL", "AUTONOMOUS"].includes(mode)) {
    throw new DecisionDomainError("VALIDATION_ERROR", "mode must be SHADOW, HUMAN_APPROVAL, or AUTONOMOUS.");
  }
  if (mode === "AUTONOMOUS") {
    throw new DecisionDomainError(
      "AUTONOMOUS_MODE_BLOCKED",
      "AUTONOMOUS decision mode is disabled. OpsPilot never executes operational actions autonomously."
    );
  }
}

function assertEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DecisionDomainError("VALIDATION_ERROR", `${field} must be one of: ${allowed.join(", ")}.`);
  }
}

export function validateCreateDecision(input: CreateDecisionInput): void {
  assertModeAllowed(input.mode);
  assertEnum(input.riskLevel, "riskLevel", ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const satisfies readonly DecisionRiskLevel[]);
  validateActor(input.actor);
  requireText(input.idempotencyKey, "idempotencyKey", 200);
  requireText(input.sourceFingerprint, "sourceFingerprint", 500);
  requireText(input.sourceLinks?.sourceType, "sourceLinks.sourceType", 100);
  requireText(input.sourceLinks?.sourceId, "sourceLinks.sourceId", 500);
  requireText(input.problem, "problem");
  requireText(input.rootCause, "rootCause");
  requireText(input.recommendedAction, "recommendedAction");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) {
    throw new DecisionDomainError("VALIDATION_ERROR", "confidence must be between 0 and 100.");
  }
  if (!input.evidence || typeof input.evidence.operationalFacts !== "object") {
    throw new DecisionDomainError("VALIDATION_ERROR", "evidence.operationalFacts is required.");
  }
}

export function validateTransitionInput(input: TransitionDecisionInput): void {
  requireText(input.decisionId, "decisionId", 200);
  validateActor(input.actor);
  requireText(input.idempotencyKey, "idempotencyKey", 200);
  assertEnum(input.targetStatus, "targetStatus", ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED", "EXECUTED", "OUTCOME_PENDING", "SUCCESS", "FAILURE", "INCONCLUSIVE"] as const satisfies readonly DecisionStatus[]);
  if (input.targetStatus === "REJECTED") requireText(input.rejectReason, "rejectReason", 2000);
}

export function validateOutcomeInput(input: RecordOutcomeInput): void {
  assertEnum(input.status, "status", ["SUCCESS", "FAILURE", "INCONCLUSIVE"] as const satisfies readonly DecisionOutcomeStatus[]);
  requireText(input.observedOutcome, "observedOutcome");
  validateActor(input.actor);
  requireText(input.idempotencyKey, "idempotencyKey", 200);
  if (!Number.isFinite(Date.parse(input.measuredAt))) {
    throw new DecisionDomainError("VALIDATION_ERROR", "measuredAt must be a valid timestamp.");
  }
  if (input.status === "INCONCLUSIVE") requireText(input.inconclusiveReason, "inconclusiveReason", 2000);
}

export function validateExecutionInput(input: RecordDecisionExecutionInput): void {
  requireText(input.decisionId, "decisionId", 200);
  validateActor(input.actor);
  requireText(input.idempotencyKey, "idempotencyKey", 200);
  if (input.executionReference !== undefined) requireText(input.executionReference, "executionReference", 500);
  if (input.externalTicketId !== undefined) requireText(input.externalTicketId, "externalTicketId", 500);
  if (input.note !== undefined) requireText(input.note, "note", 2000);
  if (input.performedAt !== undefined && !Number.isFinite(Date.parse(input.performedAt))) {
    throw new DecisionDomainError("VALIDATION_ERROR", "performedAt must be a valid timestamp.");
  }
}

export function immutableSnapshot<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): unknown => {
    if (candidate && typeof candidate === "object" && !Object.isFrozen(candidate)) {
      Object.freeze(candidate);
      Object.values(candidate as Record<string, unknown>).forEach(freeze);
    }
    return candidate;
  };
  return freeze(clone) as T;
}
