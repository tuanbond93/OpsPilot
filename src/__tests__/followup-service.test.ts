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

  it("preserves the action occurrence and schedules the next check when delivery is confirmed", async () => {
    const repo = new MockFollowupRepository();
    const requestedAt = "2026-09-02T02:08:43.674Z";
    const seeded = await repo.upsertCase({
      incident_id: "incident-reopened",
      incident_key: "warehouse:reason",
      current_state: "FIRST_PUSH_PENDING",
      first_detected_at: "2026-08-28T01:00:00Z",
      last_action_requested_at: requestedAt,
      baseline_affected_order_count: 1,
      latest_affected_order_count: 1,
      current_progress_percent: 0,
      current_assessment: "no_progress",
    });
    const service = new FollowupService(repo, new ActionQueue(null));

    const result = await service.confirmFollowupAction(seeded.id, "first_push", "telegram_test");

    expect(result.ok).toBe(true);
    expect(result.followupCase.current_state).toBe("FIRST_PUSH_SENT");
    expect(result.followupCase.last_action_requested_at).toBe(requestedAt);
    expect(result.followupCase.next_action_at).toBeTruthy();
  });
});
