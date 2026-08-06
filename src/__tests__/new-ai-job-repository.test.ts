import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { SupabaseAiJobRepository } from "@/repositories/supabase/SupabaseAiJobRepository";
import { MockAiJobRepository } from "@/repositories/mock/MockAiJobRepository";


describe("AiJobRepository Refactor Tests", () => {
  beforeEach(() => {
    RepositoryFactory.clear();
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "test");
  });

  it("RepositoryFactory resolves MockAiJobRepository in test/fallback context", () => {
    const repo = RepositoryFactory.getAiJobRepository();
    expect(repo).toBeInstanceOf(MockAiJobRepository);
  });

  it("RepositoryFactory resolves SupabaseAiJobRepository in production/no-fallback context", () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "false");
    vi.stubEnv("NODE_ENV", "production");

    const repo = RepositoryFactory.getAiJobRepository();
    expect(repo).toBeInstanceOf(SupabaseAiJobRepository);
  });

  it("Explicitly supplied Supabase client is preserved and bypasses default registry", () => {
    const mockClient = { from: vi.fn() } as any;
    const repo = RepositoryFactory.getAiJobRepository(mockClient);
    expect(repo).toBeInstanceOf(SupabaseAiJobRepository);
  });

  it("MockAiJobRepository provides deterministic CRUD/read/queue behavior", async () => {
    const mockRepo = new MockAiJobRepository();
    const scheduled = new Date().toISOString();
    
    const job = await mockRepo.enqueueJob("inc-100", "high", scheduled);
    expect(job.status).toBe("PENDING");
    expect(job.incident_id).toBe("inc-100");

    const claimed = await mockRepo.claimPendingJob("worker-alpha");
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("PROCESSING");
    expect(claimed?.worker_id).toBe("worker-alpha");

    const completed = await mockRepo.markJobCompleted(job.id);
    expect(completed?.status).toBe("COMPLETED");

    const lookup = await mockRepo.getLatestJobByIncidentId("inc-100");
    expect(lookup?.id).toBe(job.id);
  });

  it("SupabaseAiJobRepository throws query errors and does not silently fall back", async () => {
    const mockClient = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("Supabase query error") }),
    } as any;

    const supabaseRepo = new SupabaseAiJobRepository(mockClient);
    await expect(supabaseRepo.getPendingJobByIncidentId("inc-100")).rejects.toThrow("Supabase query error");
  });
});
