import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAnalysisJobRow } from "@/connectors/supabase/types";
import { MockAiJobRepository } from "@/repositories/mock/MockAiJobRepository";
import { SupabaseAiJobRepository } from "@/repositories/supabase/SupabaseAiJobRepository";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function incidentId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function pendingJob(index: number): AiAnalysisJobRow {
  const now = "2026-09-23T11:00:00.000Z";
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
    incident_id: incidentId(index),
    priority: "high",
    status: "PENDING",
    attempt_count: 0,
    max_attempts: 3,
    scheduled_at: now,
    started_at: null,
    completed_at: null,
    locked_at: null,
    worker_id: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

function seedEligible(repository: MockAiJobRepository, runId = RUN_A, count = 408): void {
  repository.seedEligibleForSyncRun(runId, Array.from({ length: count }, (_, index) => ({
    incidentId: incidentId(index + 1),
    priority: "high",
  })));
}

describe("run-scoped bulk AI enqueue", () => {
  it("enqueues 408 eligible incidents from one repository RPC call", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ eligible_count: 408, already_linked_count: 0, reused_count: 0, created_count: 408 }],
      error: null,
    });
    const repository = new SupabaseAiJobRepository({ rpc } as unknown as SupabaseClient);

    await expect(repository.enqueueEligibleForSyncRun(RUN_A)).resolves.toEqual({
      eligibleCount: 408,
      alreadyLinkedCount: 0,
      reusedCount: 0,
      createdCount: 408,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enqueue_ai_analysis_jobs_for_sync_run", { p_sync_run_id: RUN_A });
  });

  it("reuses 114 pending jobs and creates only the 294 missing jobs", async () => {
    const repository = new MockAiJobRepository();
    seedEligible(repository);
    repository.seed(Array.from({ length: 114 }, (_, index) => pendingJob(index + 1)));

    await expect(repository.enqueueEligibleForSyncRun(RUN_A)).resolves.toEqual({
      eligibleCount: 408,
      alreadyLinkedCount: 0,
      reusedCount: 114,
      createdCount: 294,
    });
    const jobs = await repository.getAllJobs(500);
    expect(jobs).toHaveLength(408);
    expect(jobs.filter((job) => job.status === "PENDING")).toHaveLength(408);
    expect(new Set(jobs.map((job) => job.incident_id)).size).toBe(408);
    expect(jobs.filter((job) => job.id.startsWith("aaaaaaaa-"))).toHaveLength(114);
  });

  it("retries the same run without creating duplicate jobs", async () => {
    const repository = new MockAiJobRepository();
    seedEligible(repository);

    expect((await repository.enqueueEligibleForSyncRun(RUN_A)).createdCount).toBe(408);
    await expect(repository.enqueueEligibleForSyncRun(RUN_A)).resolves.toEqual({
      eligibleCount: 408,
      alreadyLinkedCount: 408,
      reusedCount: 0,
      createdCount: 0,
    });
    expect(await repository.getAllJobs(500)).toHaveLength(408);
  });

  it("adopts committed work after interruption before phase checkpointing", async () => {
    const repository = new MockAiJobRepository();
    seedEligible(repository);
    repository.seed(Array.from({ length: 114 }, (_, index) => pendingJob(index + 1)));

    const firstAttempt = await repository.enqueueEligibleForSyncRun(RUN_A);
    // Simulate the process stopping after the database transaction committed,
    // before SyncService could persist ENQUEUE_AI as a completed phase.
    const resumedAttempt = await repository.enqueueEligibleForSyncRun(RUN_A);

    expect(firstAttempt).toMatchObject({ reusedCount: 114, createdCount: 294 });
    expect(resumedAttempt).toMatchObject({ alreadyLinkedCount: 408, createdCount: 0 });
    expect(await repository.getAllJobs(500)).toHaveLength(408);
  });

  it("allows a later run to create a new job after the previous job completed", async () => {
    const repository = new MockAiJobRepository();
    repository.seedEligibleForSyncRun(RUN_A, [{ incidentId: incidentId(1) }]);
    repository.seedEligibleForSyncRun(RUN_B, [{ incidentId: incidentId(1) }]);

    const first = await repository.enqueueEligibleForSyncRun(RUN_A);
    const firstJob = (await repository.getAllJobs())[0];
    expect(first.createdCount).toBe(1);
    await repository.markJobCompleted(firstJob.id);

    const laterRun = await repository.enqueueEligibleForSyncRun(RUN_B);
    expect(laterRun.createdCount).toBe(1);
    expect(await repository.getAllJobs()).toHaveLength(2);
  });

  it("allows a later run to create a new job after the previous job failed", async () => {
    const repository = new MockAiJobRepository();
    repository.seedEligibleForSyncRun(RUN_A, [{ incidentId: incidentId(1) }]);
    repository.seedEligibleForSyncRun(RUN_B, [{ incidentId: incidentId(1) }]);

    await repository.enqueueEligibleForSyncRun(RUN_A);
    const firstJob = (await repository.getAllJobs())[0];
    await repository.markJobFailed(firstJob.id, "terminal failure", 0, true);

    const laterRun = await repository.enqueueEligibleForSyncRun(RUN_B);
    expect(laterRun.createdCount).toBe(1);
    expect(await repository.getAllJobs()).toHaveLength(2);
  });
});
