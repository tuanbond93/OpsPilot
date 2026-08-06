import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { SupabaseSyncRunRepository } from "@/repositories/supabase/SupabaseSyncRunRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";


describe("SyncRunRepository Refactor Tests", () => {
  beforeEach(() => {
    RepositoryFactory.clear();
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "test");
  });

  it("RepositoryFactory resolves MockSyncRunRepository in test/fallback context", () => {
    const repo = RepositoryFactory.getSyncRunRepository();
    expect(repo).toBeInstanceOf(MockSyncRunRepository);
  });

  it("RepositoryFactory resolves SupabaseSyncRunRepository in production/no-fallback context", () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "false");
    vi.stubEnv("NODE_ENV", "production");

    const repo = RepositoryFactory.getSyncRunRepository();
    expect(repo).toBeInstanceOf(SupabaseSyncRunRepository);
  });

  it("Explicitly supplied Supabase client is preserved and bypasses default registry", () => {
    const mockClient = { from: vi.fn() } as any;
    const repo = RepositoryFactory.getSyncRunRepository(mockClient);
    expect(repo).toBeInstanceOf(SupabaseSyncRunRepository);
  });

  it("MockSyncRunRepository provides deterministic CRUD/read behavior", async () => {
    const mockRepo = new MockSyncRunRepository();
    const started = new Date().toISOString();
    
    const run = await mockRepo.createSyncRun(started);
    expect(run.status).toBe("running");
    expect(run.started_at).toBe(started);

    const success = await mockRepo.updateSuccess(run.id, {
      completedAt: new Date().toISOString(),
      fetchedOrderCount: 10,
      normalizedOrderCount: 10,
      incidentCount: 2,
      durationMs: 500,
    });
    expect(success.status).toBe("success");
    expect(success.fetched_order_count).toBe(10);

    const latest = await mockRepo.getLatestSyncRun();
    expect(latest?.id).toBe(run.id);
  });

  it("SupabaseSyncRunRepository throws query errors and does not silently fall back", async () => {
    const mockClient = {
      from: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: new Error("Supabase insert error") }),
    } as any;

    const supabaseRepo = new SupabaseSyncRunRepository(mockClient);
    await expect(supabaseRepo.createSyncRun()).rejects.toThrow("Supabase insert error");
  });

  it("MockSyncRunRepository basic operations work", async () => {
    const mockRepo = new MockSyncRunRepository();
    const started = new Date().toISOString();
    const run = await mockRepo.createSyncRun(started);
    expect(run.status).toBe("running");
    expect(run.started_at).toBe(started);

    const updated = await mockRepo.updateSuccess(run.id, {
      completedAt: new Date().toISOString(),
      fetchedOrderCount: 5,
      normalizedOrderCount: 5,
      incidentCount: 1,
      durationMs: 200,
    });
    expect(updated.status).toBe("success");
  });
});
