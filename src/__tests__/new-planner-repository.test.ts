import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { SupabasePlannerRepository } from "@/repositories/supabase/SupabasePlannerRepository";
import { MockPlannerRepository } from "@/repositories/mock/MockPlannerRepository";


describe("PlannerRepository Refactor Tests", () => {
  beforeEach(() => {
    RepositoryFactory.clear();
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "test");
  });

  it("RepositoryFactory resolves MockPlannerRepository in test/fallback context", () => {
    const repo = RepositoryFactory.getPlannerRepository();
    expect(repo).toBeInstanceOf(MockPlannerRepository);
  });

  it("RepositoryFactory resolves SupabasePlannerRepository in production/no-fallback context", () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "false");
    vi.stubEnv("NODE_ENV", "production");

    const repo = RepositoryFactory.getPlannerRepository();
    expect(repo).toBeInstanceOf(SupabasePlannerRepository);
  });

  it("Explicitly supplied Supabase client is preserved and bypasses default registry", () => {
    const mockClient = { from: vi.fn() } as any;
    const repo = RepositoryFactory.getPlannerRepository(mockClient);
    expect(repo).toBeInstanceOf(SupabasePlannerRepository);
  });

  it("MockPlannerRepository provides deterministic CRUD/read behavior", async () => {
    const mockRepo = new MockPlannerRepository();
    const runData = {
      incident_id: "inc-100",
      context_hash: "hash-100",
      prompt_version: 1,
      status: "DRAFT" as any,
    };
    
    const run = await mockRepo.createPlannerRun(runData);
    expect(run.status).toBe("DRAFT");
    expect(run.context_hash).toBe("hash-100");

    const fetched = await mockRepo.getPlannerRunByContextHashAndVersion("inc-100", "hash-100", 1);
    expect(fetched?.id).toBe(run.id);

    const updated = await mockRepo.updatePlannerRunStatus(run.id, "APPROVED" as any, "operator-alpha");
    expect(updated?.status).toBe("APPROVED");
    expect(updated?.reviewed_by).toBe("operator-alpha");

    const event = await mockRepo.insertReviewEvent({
      planner_run_id: run.id,
      event_type: "APPROVED" as any,
    });
    expect(event.planner_run_id).toBe(run.id);

    const recent = await mockRepo.getRecentReviewEvents(10);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe(event.id);
  });

  it("SupabasePlannerRepository throws query errors and does not silently fall back", async () => {
    const mockClient = {
      from: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: new Error("Supabase insert error") }),
    } as any;

    const supabaseRepo = new SupabasePlannerRepository(mockClient);
    await expect(supabaseRepo.createPlannerRun({ incident_id: "inc-100" })).rejects.toThrow("Supabase insert error");
  });

  it("MockPlannerRepository basic operations work", async () => {
    const mockRepo = new MockPlannerRepository();
    const run = await mockRepo.createPlannerRun({
      incident_id: "inc-adapter",
      context_hash: "hash-adapter",
    });
    expect(run.incident_id).toBe("inc-adapter");

    const fetched = await mockRepo.getPlannerRunById(run.id);
    expect(fetched?.context_hash).toBe("hash-adapter");
  });
});
