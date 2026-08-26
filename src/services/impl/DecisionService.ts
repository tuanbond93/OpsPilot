import type { IDecisionRepository } from "@/repositories/interfaces/IDecisionRepository";
import type { IDecisionService, DecisionServiceResult } from "../interfaces/IDecisionService";
import {
  DecisionDomainError,
  validateCreateDecision,
  validateExecutionInput,
  validateOutcomeInput,
  validateTransitionInput,
  verifyOutcomeObservation,
  retrieveComparableDecisions,
  type CreateDecisionInput,
  type RecordDecisionExecutionInput,
  type RecordOutcomeInput,
  type TransitionDecisionInput,
  type VerifyDecisionOutcomeInput,
} from "@/domain/decision";

export class DecisionService implements IDecisionService {
  constructor(private readonly repository: IDecisionRepository) {}

  private failure(error: unknown): DecisionServiceResult {
    if (error instanceof DecisionDomainError) return { ok: false, error: error.code, message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "DECISION_OPERATION_FAILED", message };
  }

  private assertWriteAllowed(): void {
    if (process.env.NODE_ENV === "production" && process.env.ENABLE_DASHBOARD_WRITE_CONTROLS !== "true") {
      throw new DecisionDomainError("WRITE_CONTROLS_DISABLED", "Decision write controls are disabled in production.");
    }
  }

  private buildExecutionReference(decisionId: string, performedAt?: string): string {
    const date = new Date(performedAt || Date.now());
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const dateStamp = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("");
    const shortDecisionId = decisionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
    return `OPSP-EXE-${dateStamp}-${shortDecisionId || "UNKNOWN"}-01`;
  }

  async create(input: CreateDecisionInput): Promise<DecisionServiceResult> {
    try {
      this.assertWriteAllowed();
      validateCreateDecision(input);
      const result = await this.repository.create(input);
      return { ok: true, data: result.decision, idempotent: result.idempotent };
    } catch (error) { return this.failure(error); }
  }

  async list(limit = 100): Promise<DecisionServiceResult> {
    try { return { ok: true, data: await this.repository.list(Math.min(Math.max(limit, 1), 200)) }; }
    catch (error) { return this.failure(error); }
  }

  async get(decisionId: string): Promise<DecisionServiceResult> {
    try {
      const decision = await this.repository.getById(decisionId);
      if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${decisionId}' not found.`);
      return { ok: true, data: { decision, auditEvents: await this.repository.getAuditEvents(decisionId), outcomes: await this.repository.getOutcomes(decisionId), followupSchedules: await this.repository.getFollowupSchedules(decisionId), outcomeObservationContract: await this.repository.getOutcomeObservationContract(decisionId), outcomeVerifications: await this.repository.getOutcomeVerifications(decisionId) } };
    } catch (error) { return this.failure(error); }
  }

  async transition(input: TransitionDecisionInput): Promise<DecisionServiceResult> {
    try {
      this.assertWriteAllowed();
      validateTransitionInput(input);
      const current = await this.repository.getById(input.decisionId);
      if (!current) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
      if (current.mode === "SHADOW" && ["APPROVED", "REJECTED", "EXECUTED"].includes(input.targetStatus)) {
        throw new DecisionDomainError("SHADOW_MODE_READ_ONLY", "SHADOW decisions are observation-only and cannot be approved, rejected, or executed.");
      }
      if (input.targetStatus === "EXECUTED" && !input.executionReference?.trim()) {
        throw new DecisionDomainError("VALIDATION_ERROR", "executionReference is required; Decision Core only records externally executed work.");
      }
      const result = await this.repository.transition(input);
      return { ok: true, data: result.decision, idempotent: result.idempotent };
    } catch (error) { return this.failure(error); }
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<DecisionServiceResult> {
    try {
      this.assertWriteAllowed();
      validateOutcomeInput(input);
      const decision = await this.repository.getById(input.decisionId);
      if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
      if (decision.mode === "HUMAN_APPROVAL") {
        const contract = await this.repository.getOutcomeObservationContract(input.decisionId);
        if (!contract) throw new DecisionDomainError("OUTCOME_OBSERVATION_CONTRACT_REQUIRED", "A follow-up observation contract is required before recording a human-approved outcome.");
        if (new Date(input.measuredAt).getTime() < new Date(contract.measurementWindowEnd).getTime()) {
          throw new DecisionDomainError("OUTCOME_MEASUREMENT_WINDOW_NOT_REACHED", "Outcome evidence must be measured at or after the scheduled follow-up window.");
        }
        if (!input.evidenceRefs?.length) {
          throw new DecisionDomainError("OUTCOME_EVIDENCE_REQUIRED", "Human-approved outcomes require post-execution evidence references.");
        }
      }
      const result = await this.repository.recordOutcome(input);
      return { ok: true, data: result.decision, idempotent: result.idempotent };
    } catch (error) { return this.failure(error); }
  }

  async recordExecution(input: RecordDecisionExecutionInput): Promise<DecisionServiceResult> {
    try {
      this.assertWriteAllowed();
      validateExecutionInput(input);
      const current = await this.repository.getById(input.decisionId);
      if (!current) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
      const actionContext = current.evidence.actionContext as Record<string, unknown> | undefined;
      if (actionContext?.disposition === "HUMAN_INVESTIGATION_REQUIRED") {
        throw new DecisionDomainError("EXECUTION_BLOCKED_BY_CRITIC", "Decision requires human investigation and cannot be recorded as executed.");
      }
      const executionReference = input.executionReference?.trim() || this.buildExecutionReference(input.decisionId, input.performedAt);
      return await this.transition({
        decisionId: input.decisionId,
        targetStatus: "EXECUTED",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        executionReference,
        metadata: {
          event: "EXTERNAL_EXECUTION_RECORDED",
          channel: "MANUAL_EXTERNAL",
          opsPilotExecutionId: executionReference,
          externalTicketId: input.externalTicketId?.trim() || null,
          performedAt: input.performedAt || null,
          note: input.note?.trim() || null,
        },
      });
    } catch (error) { return this.failure(error); }
  }

  async verifyOutcome(input: VerifyDecisionOutcomeInput): Promise<DecisionServiceResult> {
    try {
      this.assertWriteAllowed();
      if (!input.source.trim()) throw new DecisionDomainError("VALIDATION_ERROR", "source is required.");
      if (!input.idempotencyKey.trim()) throw new DecisionDomainError("VALIDATION_ERROR", "idempotencyKey is required.");
      if (!Number.isFinite(Date.parse(input.observedAt))) throw new DecisionDomainError("VALIDATION_ERROR", "observedAt must be a valid timestamp.");
      const decision = await this.repository.getById(input.decisionId);
      if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
      if (decision.mode !== "HUMAN_APPROVAL") throw new DecisionDomainError("OUTCOME_VERIFIER_HUMAN_APPROVAL_ONLY", "Automatic verification is only available for human-approved executed decisions.");
      const contract = await this.repository.getOutcomeObservationContract(input.decisionId);
      if (!contract) throw new DecisionDomainError("OUTCOME_OBSERVATION_CONTRACT_REQUIRED", "An outcome observation contract is required before verification.");
      const verification = verifyOutcomeObservation(contract, input);
      const observedOutcome = verification.classification === "SUCCESS"
        ? "Affected orders reached zero in the post-execution operational snapshot."
        : verification.classification === "FAILURE"
          ? "Affected orders did not improve versus the baseline snapshot."
          : "Available operational evidence does not establish a verified successful or failed outcome.";
      const result = await this.repository.recordVerifiedOutcome({
        ...input, verification, observedOutcome,
        inconclusiveReason: verification.classification === "INCONCLUSIVE" ? verification.reasonCode : undefined,
      });
      return { ok: true, data: { decision: result.decision, verification }, idempotent: result.idempotent };
    } catch (error) { return this.failure(error); }
  }

  async getMemory(decisionId: string, limit = 10): Promise<DecisionServiceResult> {
    try {
      const decision = await this.repository.getById(decisionId);
      if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${decisionId}' not found.`);
      return { ok: true, data: retrieveComparableDecisions(decision, await this.repository.listVerifiedDecisionMemoryRecords(200), limit) };
    } catch (error) { return this.failure(error); }
  }
}
