import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceFactory } from "@/services/ServiceFactory";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { FollowupService } from "@/services/impl/FollowupService";
import { ActionQueue } from "@/engine/action-queue";

describe("Sprint 8.8 — FollowupService Architecture & Execution Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. ServiceFactory resolves FollowupService with injected dependencies", () => {
    const service = ServiceFactory.getFollowupService();
    expect(service).toBeInstanceOf(FollowupService);
  });

  it("2. FollowupService enforces input validations for confirmFollowupAction", async () => {
    const repo = new MockFollowupRepository();
    const queue = new ActionQueue(null);
    const service = new FollowupService(repo, queue);

    // Invalid action
    const res1 = await service.confirmFollowupAction("case-1", "invalid_action");
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("InvalidAction");

    // Case not found
    const res2 = await service.confirmFollowupAction("case-1", "first_push");
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe("NotFound");
  });
});
