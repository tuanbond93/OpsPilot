import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceFactory } from "@/services/ServiceFactory";
import { MockPlannerRepository } from "@/repositories/mock/MockPlannerRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockIncidentHistoryRepository } from "@/repositories/mock/MockIncidentHistoryRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { MockExceptionRepository } from "@/repositories/mock/MockExceptionRepository";
import { MockAiJobRepository } from "@/repositories/mock/MockAiJobRepository";
import { ActionQueue } from "@/engine/action-queue";
import { RootCauseAgent } from "@/agents/root-cause";
import { ActionPlannerAgent } from "@/agents/action-planner";
import { PlannerService } from "@/services/impl/PlannerService";

describe("Sprint 8.7 — PlannerService Architecture & Execution Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. ServiceFactory resolves PlannerService with injected dependencies", () => {
    const service = ServiceFactory.getPlannerService();
    expect(service).toBeInstanceOf(PlannerService);
  });

  it("2. PlannerService enforces input validations for reviewPlannerRun", async () => {
    const plannerRepo = new MockPlannerRepository();
    const incidentRepo = new MockIncidentRepository();
    const historyRepo = new MockIncidentHistoryRepository();
    const followupRepo = new MockFollowupRepository();
    const exceptionRepo = new MockExceptionRepository();
    const aiJobRepo = new MockAiJobRepository();
    const actionQueue = new ActionQueue(null);
    const rootCauseAgent = new RootCauseAgent();
    const actionPlannerAgent = new ActionPlannerAgent(plannerRepo);

    const service = new PlannerService(
      plannerRepo,
      incidentRepo,
      historyRepo,
      followupRepo,
      exceptionRepo,
      aiJobRepo,
      actionQueue,
      rootCauseAgent,
      actionPlannerAgent
    );

    // Invalid decision
    const res1 = await service.reviewPlannerRun("run-1", "INVALID_DECISION", "Operator");
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("InvalidDecision");

    // Empty reviewedBy
    const res2 = await service.reviewPlannerRun("run-1", "APPROVED", "   ");
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe("EmptyReviewedBy");
  });
});
