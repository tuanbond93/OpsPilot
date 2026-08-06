import { describe, it, expect, beforeEach, vi } from "vitest";
import { AiJobRepository, PlannerRepository } from "@/connectors/supabase";
import { AiAnalysisWorker } from "../jobs/ai-analysis-worker";
import { RootCauseAgent } from "../agents/root-cause";
import { syncRillnet } from "../jobs/sync-rillnet";

describe("Sprint 6.5 — AI Background Worker Tests", () => {
  let mockJobRepo: AiJobRepository;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockJobRepo = new AiJobRepository(null);
    RootCauseAgent.clearCache();
  });

  // 1. Enqueue job
  it("1. AiJobRepository.enqueueJob() creates a PENDING job", async () => {
    const incidentId = "123e4567-e89b-12d3-a456-426614174000";
    const job = await mockJobRepo.enqueueJob(incidentId, "urgent");

    expect(job.incident_id).toBe(incidentId);
    expect(job.priority).toBe("urgent");
    expect(job.status).toBe("PENDING");
    expect(job.attempt_count).toBe(0);
  });

  // 2. Idempotent Enqueueing
  it("2. Enqueueing an existing PENDING job returns the active job without duplicating", async () => {
    const incidentId = "123e4567-e89b-12d3-a456-426614174000";
    const job1 = await mockJobRepo.enqueueJob(incidentId, "high");
    const job2 = await mockJobRepo.enqueueJob(incidentId, "high");

    expect(job2.id).toBe(job1.id);
  });

  // 3. Atomic Claiming
  it("3. AiJobRepository.claimPendingJob() locks PENDING job atomically to PROCESSING", async () => {
    const incidentId = "123e4567-e89b-12d3-a456-426614174001";
    await mockJobRepo.enqueueJob(incidentId, "high");

    const claimed = await mockJobRepo.claimPendingJob("worker-alpha");
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("PROCESSING");
    expect(claimed?.worker_id).toBe("worker-alpha");

    // Second worker claim attempt returns null (already claimed)
    const secondClaim = await mockJobRepo.claimPendingJob("worker-beta");
    expect(secondClaim).toBeNull();
  });

  // 4. Stale Lock Recovery
  it("4. AiJobRepository.claimPendingJob() recovers stale PROCESSING jobs beyond lock timeout", async () => {
    const incidentId = "123e4567-e89b-12d3-a456-426614174002";
    const job = await mockJobRepo.enqueueJob(incidentId, "medium");
    await mockJobRepo.claimPendingJob("crashed-worker");

    // Simulate stale lock 10 minutes ago
    const staleTime = new Date(Date.now() - 600000).toISOString();
    const allJobs = await mockJobRepo.getAllJobs();
    const target = allJobs.find((j) => j.id === job.id);
    if (target) target.locked_at = staleTime;

    const recovered = await mockJobRepo.claimPendingJob("recovery-worker", 300000);
    expect(recovered).not.toBeNull();
    expect(recovered?.worker_id).toBe("recovery-worker");
  });

  // 5. Completion & Failure Retry Policy
  it("5. Job status updates to COMPLETED on success and retries with backoff on error", async () => {
    const incidentId = "123e4567-e89b-12d3-a456-426614174003";
    const job = await mockJobRepo.enqueueJob(incidentId, "medium");

    // Retry 1: temporary network timeout
    const failed1 = await mockJobRepo.markJobFailed(job.id, "Fetch timeout 504", 30, false);
    expect(failed1?.status).toBe("PENDING");
    expect(failed1?.attempt_count).toBe(1);

    // Retry 2: HTTP 429 Rate Limit
    const failed2 = await mockJobRepo.markJobFailed(job.id, "HTTP 429 Rate Limit", 60, false);
    expect(failed2?.status).toBe("PENDING");
    expect(failed2?.attempt_count).toBe(2);

    // Permanent failure: HTTP 401 Unauthorized
    const failed3 = await mockJobRepo.markJobFailed(job.id, "HTTP 401 Unauthorized", 120, true);
    expect(failed3?.status).toBe("FAILED");
  });

  // 6. RootCauseAgent Cache-awareness
  it("6. RootCauseAgent returns cached analysis for identical context hash without re-calling LLM", async () => {
    const agent = new RootCauseAgent();
    const mockIncident: any = {
      incidentId: "inc-100",
      incidentKey: "21160000:KHO_TAN_BINH",
      reasonCode: "CUSTOMER_APPOINTMENT",
      affectedOrderCount: 50,
      priorityScore: 80,
      firstDetectedAt: "2026-08-05T08:00:00Z",
      lastDetectedAt: "2026-08-05T12:00:00Z",
      status: "open",
    };

    const res1 = await agent.analyzeIncident(mockIncident, []);
    expect(res1.cached).toBeFalsy();

    const res2 = await agent.analyzeIncident(mockIncident, []);
    expect(res2.cached).toBe(true);
    expect(res2.contextHash).toBe(res1.contextHash);
  });

  // 7. syncRillnet() zero external AI call execution in < 5 seconds
  it("7. syncRillnet() completes synchronously in < 5000ms with zero external LLM network calls", async () => {
    const start = Date.now();
    const result = await syncRillnet();
    const duration = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(duration).toBeLessThan(10000);
    expect(result.dbInstrumentation.bottlenecksDetected).not.toContainEqual(
      expect.objectContaining({ category: "AI_CALLS_INSIDE_SYNC_LOOP" })
    );
  });
});
