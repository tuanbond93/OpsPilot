import { describe, expect, it } from "vitest";
import { DecisionService } from "@/services/impl/DecisionService";
import { MockDecisionRepository } from "@/repositories/mock/MockDecisionRepository";

describe("OpsPilot execution ID", () => {
  it("generates a stable, Vietnam-date execution ID when no reference is supplied", async () => {
    const repository = new MockDecisionRepository();
    const service = new DecisionService(repository);
    const created = await service.create({
      sourceLinks: { sourceType: "test", sourceId: "source" }, sourceFingerprint: "execution-id", idempotencyKey: "execution-id-create",
      problem: "Problem", rootCause: "Cause", recommendedAction: "Action", confidence: 80, riskLevel: "HIGH", mode: "HUMAN_APPROVAL", actor: "admin",
      evidence: { sourceIdentifiers: { incidentId: "incident" }, operationalFacts: {} },
    });
    const decisionId = (created.data as any).decisionId;
    await service.transition({ decisionId, targetStatus: "READY_FOR_REVIEW", actor: "admin", idempotencyKey: "ready" });
    await service.transition({ decisionId, targetStatus: "APPROVED", actor: "admin", idempotencyKey: "approve" });

    const result = await service.recordExecution({ decisionId, actor: "admin", idempotencyKey: "execute", performedAt: "2026-08-26T02:00:00.000Z" });

    expect((result.data as any).executionReference).toMatch(new RegExp(`^OPSP-EXE-20260826-${decisionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase()}-01$`));
  });
});
