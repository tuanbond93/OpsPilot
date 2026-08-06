import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { FollowupRepository } from "@/connectors/supabase/repositories/followup-repository";

describe("FollowupRepository Refactor Tests", () => {
  beforeEach(() => {
    RepositoryFactory.clear();
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "test");
  });

  it("RepositoryFactory resolves MockFollowupRepository in test/fallback context", () => {
    const repo = RepositoryFactory.getFollowupRepository();
    expect(repo).toBeInstanceOf(MockFollowupRepository);
  });

  it("RepositoryFactory resolves SupabaseFollowupRepository in production/no-fallback context", () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "false");
    vi.stubEnv("NODE_ENV", "production");

    const repo = RepositoryFactory.getFollowupRepository();
    expect(repo).toBeInstanceOf(SupabaseFollowupRepository);
  });

  it("Explicitly supplied Supabase client is preserved and bypasses default registry", () => {
    const mockClient = { from: vi.fn() } as any;
    const repo = RepositoryFactory.getFollowupRepository(mockClient);
    expect(repo).toBeInstanceOf(SupabaseFollowupRepository);
  });

  it("MockFollowupRepository provides deterministic CRUD/read behavior", async () => {
    const mockRepo = new MockFollowupRepository();
    const caseData = {
      incident_id: "inc-100",
      incident_key: "inc-key-100",
      current_state: "NEW" as any,
    };
    
    const followupCase = await mockRepo.upsertCase(caseData);
    expect(followupCase.current_state).toBe("NEW");
    expect(followupCase.incident_key).toBe("inc-key-100");

    const fetched = await mockRepo.getCaseById(followupCase.id);
    expect(fetched?.incident_id).toBe("inc-100");

    const event = await mockRepo.insertEvent({
      followup_case_id: followupCase.id,
      event_type: "CASE_CREATED" as any,
    });
    expect(event.followup_case_id).toBe(followupCase.id);

    const recent = await mockRepo.getRecentEvents(10);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe(event.id);
  });

  it("SupabaseFollowupRepository throws query errors and does not silently fall back", async () => {
    const mockClient = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("Supabase lookup error") }),
    } as any;

    const supabaseRepo = new SupabaseFollowupRepository(mockClient);
    await expect(supabaseRepo.getCaseById("id-100")).rejects.toThrow("Supabase lookup error");
  });

  it("Existing FollowupRepository adapter wrapper still works", async () => {
    const adapter = new FollowupRepository(null);
    const caseData = {
      incident_id: "inc-adapter",
      incident_key: "inc-key-adapter",
      current_state: "NEW" as any,
    };
    const followupCase = await adapter.upsertCase(caseData);
    expect(followupCase.incident_id).toBe("inc-adapter");

    const fetched = await adapter.getCaseById(followupCase.id);
    expect(fetched?.incident_key).toBe("inc-key-adapter");
  });
});
