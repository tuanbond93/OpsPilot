import { describe, expect, it } from "vitest";
import { MockDecisionRepository } from "@/repositories/mock/MockDecisionRepository";
import { MockExecutionWorkOrderRepository } from "@/repositories/mock/MockExecutionWorkOrderRepository";
import { ExecutionWorkOrderService } from "@/services/impl/ExecutionWorkOrderService";
import { DecisionService } from "@/services/impl/DecisionService";

describe("Execution Work Order", () => {
  it("creates an immutable internal code only after a human decision is approved", async () => {
    const decisions = new MockDecisionRepository(); const decisionService = new DecisionService(decisions);
    const service = new ExecutionWorkOrderService(decisions, new MockExecutionWorkOrderRepository());
    const created = await decisionService.create({ sourceLinks: { sourceType: "test", sourceId: "wo" }, sourceFingerprint: "wo", idempotencyKey: "wo-create", problem: "p", rootCause: "r", recommendedAction: "a", confidence: 80, riskLevel: "HIGH", mode: "HUMAN_APPROVAL", actor: "admin", evidence: { sourceIdentifiers: {}, operationalFacts: {} } });
    const decisionId = (created.data as any).decisionId;
    await decisionService.transition({ decisionId, targetStatus: "READY_FOR_REVIEW", actor: "admin", idempotencyKey: "wo-ready" });
    await decisionService.transition({ decisionId, targetStatus: "APPROVED", actor: "admin", idempotencyKey: "wo-approved" });

    const result = await service.create({ decisionId, actor: "admin", idempotencyKey: "work-order", owner: "Kho A", dueAt: "2026-08-27T00:00:00.000Z", actionItems: ["Xác minh điểm nghẽn"] });
    expect(result.workOrder).toMatchObject({ decisionId, status: "OPEN", owner: "Kho A", actionItems: ["Xác minh điểm nghẽn"] });
    expect(result.workOrder.workOrderCode).toMatch(/^OPSP-WO-\d{8}-[A-Z0-9]{8}-01$/);
    expect((await service.transition({ decisionId, actor: "admin", idempotencyKey: "work-order-start", targetStatus: "IN_PROGRESS" })).workOrder.status).toBe("IN_PROGRESS");
    expect((await service.transition({ decisionId, actor: "admin", idempotencyKey: "work-order-complete", targetStatus: "COMPLETED" })).workOrder.status).toBe("COMPLETED");
  });
});
