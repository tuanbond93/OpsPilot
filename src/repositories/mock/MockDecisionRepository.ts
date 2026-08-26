import type { IDecisionRepository, DecisionMutationResult } from "../interfaces/IDecisionRepository";
import {
  assertDecisionTransition,
  buildDecisionFollowupSchedule,
  buildOutcomeObservationContract,
  DecisionDomainError,
  immutableSnapshot,
  type CreateDecisionInput,
  type Decision,
  type DecisionAuditEvent,
  type DecisionFollowupSchedule,
  type DecisionOutcomeObservationContract,
  type DecisionOutcomeRecord,
  type DecisionOutcomeVerification,
  type RecordOutcomeInput,
  type VerifyDecisionOutcomeInput,
  type VerifiedDecisionMemoryRecord,
  type TransitionDecisionInput,
} from "@/domain/decision";

export class MockDecisionRepository implements IDecisionRepository {
  private decisions = new Map<string, Decision>();
  private auditEvents: DecisionAuditEvent[] = [];
  private outcomes: DecisionOutcomeRecord[] = [];
  private followupSchedules: DecisionFollowupSchedule[] = [];
  private outcomeObservationContracts: DecisionOutcomeObservationContract[] = [];
  private outcomeVerifications: DecisionOutcomeVerification[] = [];

  clearMemory(): void {
    this.decisions.clear();
    this.auditEvents = [];
    this.outcomes = [];
    this.followupSchedules = [];
    this.outcomeObservationContracts = [];
    this.outcomeVerifications = [];
  }

  async create(input: CreateDecisionInput): Promise<DecisionMutationResult> {
    const existing = [...this.decisions.values()].find(
      (item) => item.sourceFingerprint === input.sourceFingerprint || item.idempotencyKey === input.idempotencyKey
    );
    if (existing) return { decision: immutableSnapshot(existing), idempotent: true };

    const now = new Date().toISOString();
    const decisionId = crypto.randomUUID();
    const decision: Decision = {
      decisionId,
      sourceLinks: immutableSnapshot(input.sourceLinks),
      sourceFingerprint: input.sourceFingerprint,
      idempotencyKey: input.idempotencyKey,
      problem: input.problem.trim(),
      rootCause: input.rootCause.trim(),
      recommendedAction: input.recommendedAction.trim(),
      alternatives: immutableSnapshot(input.alternatives || []),
      evidence: immutableSnapshot({ ...input.evidence, capturedAt: input.evidence.capturedAt || now }),
      confidence: input.confidence,
      riskLevel: input.riskLevel,
      decisionStatus: "DRAFT",
      mode: input.mode,
      financialImpact: { status: "NOT_EVALUATED" },
      createdAt: now,
      updatedAt: now,
      decisionDeadline: input.decisionDeadline || null,
    };
    this.decisions.set(decisionId, decision);
    this.auditEvents.push(immutableSnapshot({
      eventId: crypto.randomUUID(), decisionId, idempotencyKey: input.idempotencyKey,
      actor: input.actor.trim(), occurredAt: now, previousStatus: null, newStatus: "DRAFT",
      metadata: { event: "DECISION_CREATED" },
    }));
    return { decision: immutableSnapshot(decision), idempotent: false };
  }

  async getById(decisionId: string): Promise<Decision | null> {
    const item = this.decisions.get(decisionId);
    return item ? immutableSnapshot(item) : null;
  }

  async list(limit = 100): Promise<Decision[]> {
    return [...this.decisions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(immutableSnapshot);
  }

  async transition(input: TransitionDecisionInput): Promise<DecisionMutationResult> {
    const decision = this.decisions.get(input.decisionId);
    if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
    const priorEvent = this.auditEvents.find(
      (event) => event.decisionId === input.decisionId && event.idempotencyKey === input.idempotencyKey
    );
    if (priorEvent) return { decision: immutableSnapshot(decision), idempotent: true };
    assertDecisionTransition(decision.decisionStatus, input.targetStatus);
    const now = new Date().toISOString();
    const previousStatus = decision.decisionStatus;
    const updated: Decision = { ...decision, decisionStatus: input.targetStatus, updatedAt: now };
    if (input.targetStatus === "APPROVED") Object.assign(updated, { approvedBy: input.actor, approvedAt: now });
    if (input.targetStatus === "REJECTED") Object.assign(updated, { rejectedBy: input.actor, rejectedAt: now, rejectReason: input.rejectReason });
    if (input.targetStatus === "EXECUTED") Object.assign(updated, { executedBy: input.actor, executedAt: now, executionReference: input.executionReference || null });
    const eventId = crypto.randomUUID();
    this.auditEvents.push(immutableSnapshot({
      eventId, decisionId: input.decisionId, idempotencyKey: input.idempotencyKey,
      actor: input.actor, occurredAt: now, previousStatus, newStatus: input.targetStatus,
      metadata: immutableSnapshot(input.metadata || {}),
    }));
    if (input.targetStatus === "EXECUTED") {
      const schedule = immutableSnapshot(buildDecisionFollowupSchedule({
        decisionId: input.decisionId, executionAuditEventId: eventId, riskLevel: updated.riskLevel,
        scheduledBy: input.actor, idempotencyKey: `${input.idempotencyKey}:followup`, executedAt: now,
      }));
      this.followupSchedules.push(schedule);
      updated.followupSchedule = schedule;
      const contract = buildOutcomeObservationContract({ decision: updated, schedule });
      this.outcomeObservationContracts.push(contract);
      updated.outcomeObservationContract = contract;
    }
    this.decisions.set(input.decisionId, updated);
    return { decision: immutableSnapshot(updated), idempotent: false };
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<DecisionMutationResult> {
    const prior = this.outcomes.find((item) => item.decisionId === input.decisionId &&
      this.auditEvents.some((event) => event.decisionId === item.decisionId && event.idempotencyKey === input.idempotencyKey));
    const decision = this.decisions.get(input.decisionId);
    if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
    if (prior) return { decision: immutableSnapshot(decision), idempotent: true };
    if (decision.mode === "SHADOW") {
      const now = new Date().toISOString();
      const outcome: DecisionOutcomeRecord = immutableSnapshot({
        outcomeId: crypto.randomUUID(), decisionId: input.decisionId, status: input.status,
        observedOutcome: input.observedOutcome, measuredAt: input.measuredAt,
        evidenceRefs: input.evidenceRefs || [], inconclusiveReason: input.inconclusiveReason || null,
        recordedBy: input.actor, recordedAt: now,
      });
      this.outcomes.push(outcome);
      const updated = { ...decision, outcomeStatus: input.status, outcomeRecordedAt: now, updatedAt: now };
      this.decisions.set(input.decisionId, updated);
      this.auditEvents.push(immutableSnapshot({
        eventId: crypto.randomUUID(), decisionId: input.decisionId, idempotencyKey: input.idempotencyKey,
        actor: input.actor, occurredAt: now, previousStatus: decision.decisionStatus,
        newStatus: decision.decisionStatus, metadata: { event: "SHADOW_OUTCOME_OBSERVED", outcomeId: outcome.outcomeId },
      }));
      return { decision: immutableSnapshot(updated), idempotent: false };
    }
    const pending = decision.decisionStatus === "EXECUTED"
      ? (await this.transition({ decisionId: input.decisionId, targetStatus: "OUTCOME_PENDING", actor: input.actor,
          idempotencyKey: `${input.idempotencyKey}:pending`, metadata: { event: "OUTCOME_MEASUREMENT_STARTED" } })).decision
      : decision;
    assertDecisionTransition(pending.decisionStatus, input.status);
    const now = new Date().toISOString();
    const outcome: DecisionOutcomeRecord = immutableSnapshot({
      outcomeId: crypto.randomUUID(), decisionId: input.decisionId, status: input.status,
      observedOutcome: input.observedOutcome, measuredAt: input.measuredAt,
      evidenceRefs: input.evidenceRefs || [], inconclusiveReason: input.inconclusiveReason || null,
      recordedBy: input.actor, recordedAt: now,
    });
    this.outcomes.push(outcome);
    const result = await this.transition({ decisionId: input.decisionId, targetStatus: input.status, actor: input.actor,
      idempotencyKey: input.idempotencyKey, metadata: { outcomeId: outcome.outcomeId, measuredAt: input.measuredAt } });
    const finalDecision = { ...result.decision, outcomeStatus: input.status, outcomeRecordedAt: now };
    this.decisions.set(input.decisionId, finalDecision);
    return { decision: immutableSnapshot(finalDecision), idempotent: false };
  }

  async getAuditEvents(decisionId: string): Promise<readonly DecisionAuditEvent[]> {
    return immutableSnapshot(this.auditEvents.filter((event) => event.decisionId === decisionId));
  }

  async getOutcomes(decisionId: string): Promise<readonly DecisionOutcomeRecord[]> {
    return immutableSnapshot(this.outcomes.filter((item) => item.decisionId === decisionId));
  }

  async getFollowupSchedules(decisionId: string): Promise<readonly DecisionFollowupSchedule[]> {
    return immutableSnapshot(this.followupSchedules.filter((item) => item.decisionId === decisionId));
  }

  async getOutcomeObservationContract(decisionId: string): Promise<DecisionOutcomeObservationContract | null> {
    const contract = this.outcomeObservationContracts.find((item) => item.decisionId === decisionId);
    return contract ? immutableSnapshot(contract) : null;
  }

  async recordVerifiedOutcome(input: VerifyDecisionOutcomeInput & { verification: Omit<DecisionOutcomeVerification, "verificationId" | "createdAt">; observedOutcome: string; inconclusiveReason?: string }): Promise<DecisionMutationResult> {
    const existing = this.outcomeVerifications.find((item) => item.decisionId === input.decisionId && item.evidenceRefs.join("|") === input.evidenceRefs.join("|") && item.observedAt === input.observedAt);
    if (existing) {
      const decision = this.decisions.get(input.decisionId);
      if (!decision) throw new DecisionDomainError("NOT_FOUND", `Decision '${input.decisionId}' not found.`);
      return { decision: immutableSnapshot(decision), idempotent: true };
    }
    const result = await this.recordOutcome({
      decisionId: input.decisionId, status: input.verification.classification, observedOutcome: input.observedOutcome,
      measuredAt: input.observedAt, evidenceRefs: input.evidenceRefs, inconclusiveReason: input.inconclusiveReason,
      actor: input.actor, idempotencyKey: input.idempotencyKey,
    });
    if (!result.idempotent) this.outcomeVerifications.push(immutableSnapshot({ ...input.verification, verificationId: crypto.randomUUID(), createdAt: new Date().toISOString() }));
    return result;
  }

  async getOutcomeVerifications(decisionId: string): Promise<readonly DecisionOutcomeVerification[]> {
    return immutableSnapshot(this.outcomeVerifications.filter((item) => item.decisionId === decisionId));
  }

  async listVerifiedDecisionMemoryRecords(limit = 200): Promise<readonly VerifiedDecisionMemoryRecord[]> {
    return immutableSnapshot(this.outcomeVerifications.slice(-limit).flatMap((verification) => {
      const decision = this.decisions.get(verification.decisionId);
      return decision ? [{ decision, verification }] : [];
    }));
  }
}
