import { describe, it, expect, beforeEach } from "vitest";
import { MockCopilotRepository } from "@/repositories/mock/MockCopilotRepository";
import { MockSyncLockRepository } from "@/repositories/mock/MockSyncLockRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { CopilotService } from "@/services/impl/CopilotService";
import { AIWorkflowService } from "@/workflow/AIWorkflowService";
import { WorkflowState } from "@/workflow/WorkflowState";

describe("Sprint 12.4 — V1 Concurrency, Idempotency & Concurrency Hardening", () => {
  let copilotRepo: MockCopilotRepository;
  let syncLockRepo: MockSyncLockRepository;
  let copilotService: CopilotService;

  beforeEach(() => {
    RepositoryFactory.clear();
    copilotRepo = new MockCopilotRepository();
    syncLockRepo = new MockSyncLockRepository();
    RepositoryFactory.registerCopilotRepository(copilotRepo);
    RepositoryFactory.registerSyncLockRepository(syncLockRepo);
    copilotService = new CopilotService(copilotRepo);
  });

  describe("Lock Contention & Lock Exclusion", () => {
    it("prevents concurrent lock acquisition for the same worker key", async () => {
      const lock1 = await syncLockRepo.acquireLock("sync_worker", "worker-1", 5000);
      expect(lock1.acquired).toBe(true);

      const lock2 = await syncLockRepo.acquireLock("sync_worker", "worker-2", 5000);
      expect(lock2.acquired).toBe(false);

      await syncLockRepo.releaseLock("sync_worker", "worker-1");

      const lock3 = await syncLockRepo.acquireLock("sync_worker", "worker-2", 5000);
      expect(lock3.acquired).toBe(true);
    });
  });

  describe("Concurrent Copilot Review Submission", () => {
    it("handles parallel review submissions safely and maintains exactly one active review", async () => {
      const run = await copilotRepo.createCopilotRun({
        incident_id: "inc-conc-1",
        workflow_id: "wf-conc-1",
        copilot_result: { summary: "Concurrent test run" },
      });

      // Submit 5 reviews concurrently
      const promises = Array.from({ length: 5 }, (_, i) =>
        copilotRepo.createReview({
          run_id: run.id,
          incident_id: "inc-conc-1",
          workflow_id: "wf-conc-1",
          status: i % 2 === 0 ? "APPROVED" : "EDITED",
          edited_result: i % 2 !== 0 ? { summary: `Edit ${i}` } : null,
          reviewed_by: `operator-${i}`,
          is_active: true,
        })
      );

      await Promise.all(promises);

      const allReviews = await copilotRepo.listReviewsByRunId(run.id);
      expect(allReviews.length).toBe(5);

      const activeReviews = allReviews.filter((r) => r.is_active);
      expect(activeReviews.length).toBe(1);

      const supersededCount = allReviews.filter((r) => r.status === "SUPERSEDED").length;
      expect(supersededCount).toBe(4);
    });
  });

  describe("Workflow Pause & Concurrent Resume Idempotency", () => {
    it("handles concurrent resume calls without duplicate Followup executions", async () => {
      const incidentRepo = RepositoryFactory.getIncidentRepository() as MockIncidentRepository;
      incidentRepo.seed([
        {
          id: "inc-conc-2",
          incident_key: "KEY-CONC-2",
          warehouse_id: "WH-1",
          warehouse_name: "Warehouse 1",
          reason_code: "MISSING_PACKAGE",
          reason_name: "Missing Package",
          status: "open",
          priority_score: 50,
          first_detected_at: new Date().toISOString(),
          last_detected_at: new Date().toISOString(),
        },
      ]);

      const workflow = new AIWorkflowService("wf-conc-2");
      const execRes = await workflow.execute("inc-conc-2");
      expect(execRes.state).toBe(WorkflowState.COPILOT_AWAITING_REVIEW);

      // Submit review
      await copilotService.reviewCopilotRun(
        "inc-conc-2",
        { status: "APPROVED" },
        "operator-conc"
      );

      // Concurrent resume requests
      const resumePromises = Array.from({ length: 5 }, () =>
        workflow.resumeAfterCopilotReview("inc-conc-2")
      );

      const results = await Promise.all(resumePromises);
      for (const res of results) {
        expect(res.state).toBe(WorkflowState.COMPLETED);
      }
    });
  });
});
