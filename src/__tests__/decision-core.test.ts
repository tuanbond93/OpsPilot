import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { canTransition, immutableSnapshot, type CreateDecisionInput, type DecisionStatus } from "@/domain/decision";
import { MockDecisionRepository } from "@/repositories/mock/MockDecisionRepository";
import { DecisionService } from "@/services/impl/DecisionService";

function input(overrides: Partial<CreateDecisionInput> = {}): CreateDecisionInput {
  return {
    sourceLinks: { sourceType: "PLANNER_RUN", sourceId: "planner-1", incidentId: "incident-1", plannerRunId: "planner-1" },
    sourceFingerprint: "incident-1:planner-1:v1", idempotencyKey: "create-1",
    problem: "Backlog exceeds SLA", rootCause: "Warehouse capacity constraint",
    recommendedAction: "Review staffing plan", alternatives: ["Continue monitoring"],
    evidence: { sourceIdentifiers: { incidentId: "incident-1" }, operationalFacts: { affectedOrders: 42 } },
    confidence: 82, riskLevel: "HIGH", mode: "HUMAN_APPROVAL", actor: "operator@example.com",
    ...overrides,
  };
}

describe("Decision Core lifecycle and safety", () => {
  let repository: MockDecisionRepository;
  let service: DecisionService;
  beforeEach(() => { repository = new MockDecisionRepository(); service = new DecisionService(repository); delete process.env.ENABLE_DASHBOARD_WRITE_CONTROLS; });
  afterEach(() => { delete process.env.ENABLE_DASHBOARD_WRITE_CONTROLS; vi.unstubAllEnvs(); });

  it("defines every valid forward transition and rejects all other pairs", () => {
    const statuses: DecisionStatus[] = ["DRAFT","READY_FOR_REVIEW","APPROVED","REJECTED","EXECUTED","OUTCOME_PENDING","SUCCESS","FAILURE","INCONCLUSIVE"];
    const valid = new Set(["DRAFT>READY_FOR_REVIEW","READY_FOR_REVIEW>APPROVED","READY_FOR_REVIEW>REJECTED","APPROVED>EXECUTED","EXECUTED>OUTCOME_PENDING","OUTCOME_PENDING>SUCCESS","OUTCOME_PENDING>FAILURE","OUTCOME_PENDING>INCONCLUSIVE"]);
    for (const from of statuses) for (const to of statuses) expect(canTransition(from, to)).toBe(valid.has(`${from}>${to}`));
  });

  it("enforces rejectReason and actor guard", async () => {
    const created = await service.create(input());
    const decisionId = (created.data as any).decisionId;
    await service.transition({ decisionId, targetStatus: "READY_FOR_REVIEW", actor: "operator", idempotencyKey: "ready-1" });
    expect((await service.transition({ decisionId, targetStatus: "REJECTED", actor: "operator", idempotencyKey: "reject-1" })).error).toBe("VALIDATION_ERROR");
    expect((await service.transition({ decisionId, targetStatus: "REJECTED", actor: " ", idempotencyKey: "reject-2", rejectReason: "Insufficient evidence" })).error).toBe("VALIDATION_ERROR");
  });

  it("makes create and transition retries idempotent without duplicate audit", async () => {
    const first = await service.create(input());
    const retry = await service.create(input());
    expect(first.idempotent).toBe(false); expect(retry.idempotent).toBe(true);
    const decisionId = (first.data as any).decisionId;
    const transition = { decisionId, targetStatus: "READY_FOR_REVIEW" as const, actor: "operator", idempotencyKey: "ready-idem" };
    expect((await service.transition(transition)).idempotent).toBe(false);
    expect((await service.transition(transition)).idempotent).toBe(true);
    expect((await repository.getAuditEvents(decisionId))).toHaveLength(2);
  });

  it("blocks AUTONOMOUS at runtime and keeps SHADOW review read-only", async () => {
    expect((await service.create(input({ mode: "AUTONOMOUS" }))).error).toBe("AUTONOMOUS_MODE_BLOCKED");
    const shadow = await service.create(input({ mode: "SHADOW", sourceFingerprint: "shadow", idempotencyKey: "shadow-create" }));
    const decisionId = (shadow.data as any).decisionId;
    await service.transition({ decisionId, targetStatus: "READY_FOR_REVIEW", actor: "system", idempotencyKey: "shadow-ready" });
    expect((await service.transition({ decisionId, targetStatus: "APPROVED", actor: "operator", idempotencyKey: "shadow-approve" })).error).toBe("SHADOW_MODE_READ_ONLY");
  });

  it("returns immutable evidence and audit snapshots", async () => {
    const source = input(); const created = await service.create(source); const decision = created.data as any;
    source.evidence.operationalFacts.affectedOrders = 999;
    expect(decision.evidence.operationalFacts.affectedOrders).toBe(42);
    expect(Object.isFrozen(decision.evidence)).toBe(true);
    const audit = await repository.getAuditEvents(decision.decisionId);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(() => ((audit[0].metadata as any).tampered = true)).toThrow();
  });

  it("tracks HUMAN_APPROVAL outcome without financial calculations", async () => {
    const created = await service.create(input()); const id = (created.data as any).decisionId;
    await service.transition({ decisionId: id, targetStatus: "READY_FOR_REVIEW", actor: "a", idempotencyKey: "r" });
    await service.transition({ decisionId: id, targetStatus: "APPROVED", actor: "a", idempotencyKey: "a" });
    await service.transition({ decisionId: id, targetStatus: "EXECUTED", actor: "a", idempotencyKey: "e", executionReference: "external-ticket-1" });
    const result = await service.recordOutcome({ decisionId: id, status: "SUCCESS", observedOutcome: "Backlog returned below SLA", measuredAt: new Date().toISOString(), evidenceRefs: ["snapshot:2"], actor: "observer", idempotencyKey: "o" });
    expect(result.ok).toBe(true); expect((result.data as any).financialImpact).toEqual({ status: "NOT_EVALUATED" });
    expect(JSON.stringify(await repository.getOutcomes(id))).not.toMatch(/saving|cost|financial/i);
  });

  it("records only externally performed work and keeps execution idempotent", async () => {
    const created = await service.create(input()); const id = (created.data as any).decisionId;
    await service.transition({ decisionId: id, targetStatus: "READY_FOR_REVIEW", actor: "manager", idempotencyKey: "ready-exec" });
    await service.transition({ decisionId: id, targetStatus: "APPROVED", actor: "manager", idempotencyKey: "approve-exec" });
    const execution = { decisionId: id, actor: "operator", idempotencyKey: "execute-1", executionReference: "ticket:OPS-123", performedAt: "2026-08-26T03:00:00.000Z", note: "Completed by warehouse lead" };
    const first = await service.recordExecution(execution);
    const retry = await service.recordExecution(execution);
    expect(first.ok).toBe(true); expect(first.idempotent).toBe(false);
    expect(retry.ok).toBe(true); expect(retry.idempotent).toBe(true);
    expect((first.data as any)).toMatchObject({ decisionStatus: "EXECUTED", executionReference: "ticket:OPS-123", executedBy: "operator" });
    const audit = await repository.getAuditEvents(id);
    expect(audit.at(-1)?.metadata).toMatchObject({ event: "EXTERNAL_EXECUTION_RECORDED", channel: "MANUAL_EXTERNAL", performedAt: "2026-08-26T03:00:00.000Z" });
    const schedules = await repository.getFollowupSchedules(id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ decisionId: id, status: "SCHEDULED", policyVersion: "LC04_V1", riskLevelAtSchedule: "HIGH", scheduledBy: "operator", idempotencyKey: "execute-1:followup" });
    expect(new Date(schedules[0].checkAt).getTime() - new Date(schedules[0].createdAt).getTime()).toBe(120 * 60_000);
    expect((await repository.getById(id))?.followupSchedule?.scheduleId).toBe(schedules[0].scheduleId);
  });

  it.each([
    ["CRITICAL", 60], ["HIGH", 120], ["MEDIUM", 240], ["LOW", 480],
  ] as const)("schedules %s risk follow-up after %i minutes", async (riskLevel, expectedMinutes) => {
    const created = await service.create(input({ riskLevel, sourceFingerprint: `risk:${riskLevel}`, idempotencyKey: `create:${riskLevel}` }));
    const id = (created.data as any).decisionId;
    await service.transition({ decisionId: id, targetStatus: "READY_FOR_REVIEW", actor: "manager", idempotencyKey: `ready:${riskLevel}` });
    await service.transition({ decisionId: id, targetStatus: "APPROVED", actor: "manager", idempotencyKey: `approve:${riskLevel}` });
    await service.recordExecution({ decisionId: id, actor: "operator", idempotencyKey: `execute:${riskLevel}`, executionReference: `ticket:${riskLevel}` });
    const [schedule] = await repository.getFollowupSchedules(id);
    expect(new Date(schedule.checkAt).getTime() - new Date(schedule.createdAt).getTime()).toBe(expectedMinutes * 60_000);
  });

  it("blocks execution when the critic requires human investigation", async () => {
    const guarded = input({ evidence: { sourceIdentifiers: { incidentId: "incident-guarded" }, operationalFacts: {}, actionContext: { disposition: "HUMAN_INVESTIGATION_REQUIRED" } }, sourceFingerprint: "guarded", idempotencyKey: "guarded-create" });
    const created = await service.create(guarded); const id = (created.data as any).decisionId;
    await service.transition({ decisionId: id, targetStatus: "READY_FOR_REVIEW", actor: "manager", idempotencyKey: "guarded-ready" });
    await service.transition({ decisionId: id, targetStatus: "APPROVED", actor: "manager", idempotencyKey: "guarded-approve" });
    const result = await service.recordExecution({ decisionId: id, actor: "operator", idempotencyKey: "guarded-execute", executionReference: "ticket:unsafe" });
    expect(result.error).toBe("EXECUTION_BLOCKED_BY_CRITIC");
    expect((await repository.getById(id))?.decisionStatus).toBe("APPROVED");
    expect(await repository.getFollowupSchedules(id)).toHaveLength(0);
  });

  it("records SHADOW actual outcome without approval or execution transition", async () => {
    const created = await service.create(input({ mode: "SHADOW", sourceFingerprint: "shadow-2", idempotencyKey: "shadow-2" }));
    const id = (created.data as any).decisionId;
    const result = await service.recordOutcome({ decisionId: id, status: "INCONCLUSIVE", observedOutcome: "External operation changed during observation", inconclusiveReason: "Confounding manual intervention", measuredAt: new Date().toISOString(), actor: "observer", idempotencyKey: "shadow-outcome" });
    expect(result.ok).toBe(true); expect((result.data as any).decisionStatus).toBe("DRAFT");
    expect(await repository.getOutcomes(id)).toHaveLength(1);
  });

  it("requires production write controls", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await service.create(input())).error).toBe("WRITE_CONTROLS_DISABLED");
  });

  it("deep-freezes independently cloned values", () => {
    const original = { facts: { count: 1 } }; const snapshot = immutableSnapshot(original);
    original.facts.count = 2; expect(snapshot.facts.count).toBe(1); expect(Object.isFrozen(snapshot.facts)).toBe(true);
  });
});
