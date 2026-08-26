import type { IDecisionRepository } from "@/repositories/interfaces/IDecisionRepository";
import type { IDecisionService, DecisionServiceResult } from "../interfaces/IDecisionService";
import {
  DecisionDomainError,
  validateCreateDecision,
  validateExecutionInput,
  validateOutcomeInput,
  validateTransitionInput,
  type CreateDecisionInput,
  type RecordDecisionExecutionInput,
  type RecordOutcomeInput,
  type TransitionDecisionInput,
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
      return { ok: true, data: { decision, auditEvents: await this.repository.getAuditEvents(decisionId), outcomes: await this.repository.getOutcomes(decisionId) } };
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
      return await this.transition({
        decisionId: input.decisionId,
        targetStatus: "EXECUTED",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        executionReference: input.executionReference.trim(),
        metadata: {
          event: "EXTERNAL_EXECUTION_RECORDED",
          channel: "MANUAL_EXTERNAL",
          performedAt: input.performedAt || null,
          note: input.note?.trim() || null,
        },
      });
    } catch (error) { return this.failure(error); }
  }
}
