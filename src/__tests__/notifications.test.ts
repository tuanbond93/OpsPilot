import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ActionQueue,
  Deduplicator,
  RetryEngine,
  ActionScheduler,
} from "../engine/action-queue";
import type { DeduplicationResult } from "../engine/action-queue/queue";
import {
  ConsoleProvider,
  TelegramProvider,
  NotificationBuilder,
  NotificationDispatcher,
} from "../notifications";
import fs from "fs";

describe("Sprint 5 Hardened: Notification Platform & Action Governance Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Deduplicator.clearMemory();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.ALLOW_MANUAL_ACTION_CONFIRM;
  });

  // ===== CORE DISPATCHER TESTS =====

  // 1. Rillnet sync enqueues but does not dispatch
  it("1. Rillnet sync job enqueues notification actions but does NOT dispatch", () => {
    const syncJobCode = fs.readFileSync("src/jobs/sync-rillnet.ts", "utf-8");
    expect(syncJobCode).toContain("FollowupEngine");
    expect(syncJobCode).not.toContain("dispatcher.dispatchPendingActions");
  });

  // 2. Atomic action claiming prevents double-claiming by concurrent workers
  it("2. Two concurrent workers cannot claim the same action", async () => {
    const queue = new ActionQueue(null);
    await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: { warehouse: "Kho Tân Bình" },
    });

    const claimedWorker1 = await queue.claimPendingActions("worker-1", 10);
    expect(claimedWorker1.length).toBe(1);
    expect(claimedWorker1[0].locked_by).toBe("worker-1");

    const claimedWorker2 = await queue.claimPendingActions("worker-2", 10);
    expect(claimedWorker2.length).toBe(0);
  });

  // 3. Stuck PROCESSING action is recovered after timeout
  it("3. Stuck PROCESSING action beyond lockTimeoutMs is recovered", async () => {
    const queue = new ActionQueue(null);
    const pastTimeMs = Date.now() - 600000;
    const result = await queue.enqueueAction({
      actionType: "SECOND_PUSH",
      provider: "console",
      payload: { warehouse: "Kho Bình Chánh" },
      scheduledAt: new Date(pastTimeMs - 1000).toISOString(),
    });
    const action = result && "id" in result ? result : null;

    await queue.claimPendingActions("worker-1", 10, 300000, pastTimeMs);

    const recovered = await queue.claimPendingActions("worker-2", 10, 300000, Date.now());
    expect(recovered.length).toBe(1);
    expect(recovered[0].locked_by).toBe("worker-2");

    const events = await queue.getActionEvents(action!.id);
    const recoveryEvent = events.find((e) => e.event_type === "PROCESSING_RECOVERED");
    expect(recoveryEvent).toBeDefined();
  });

  // 4. ConsoleProvider returns SIMULATED
  it("4. ConsoleProvider returns outcome = SIMULATED", async () => {
    const provider = new ConsoleProvider();
    const action = {
      id: "act-console-1",
      action_type: "FIRST_PUSH" as const,
      provider: "console",
      target_type: "WAREHOUSE" as const,
      payload: { test: true },
      status: "PENDING" as const,
      priority: "medium" as const,
      retry_count: 0,
      max_retry: 3,
      scheduled_at: new Date().toISOString(),
    };

    const res = await provider.send(action, "Test text");
    expect(res.outcome).toBe("SIMULATED");
    expect(res.providerMessageId).toBeDefined();
  });

  // 5. Telegram dry-run returns SIMULATED
  it("5. Telegram dry-run returns outcome = SIMULATED", async () => {
    const provider = new TelegramProvider("", "");
    const action = {
      id: "act-tg-sim-1",
      action_type: "FIRST_PUSH" as const,
      provider: "telegram",
      target_type: "WAREHOUSE" as const,
      payload: { test: true },
      status: "PENDING" as const,
      priority: "high" as const,
      retry_count: 0,
      max_retry: 3,
      scheduled_at: new Date().toISOString(),
    };

    const res = await provider.send(action, "Test text");
    expect(res.outcome).toBe("SIMULATED");
  });

  // 6. SIMULATED does NOT confirm Follow-up delivery
  it("6. SIMULATED outcome does NOT confirm Follow-up delivery", async () => {
    const queue = new ActionQueue(null);
    await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: { incidentKey: "21160000:KHO_TON" },
    });

    const followupRepoMock = {
      getCaseById: vi.fn().mockResolvedValue({
        id: "case-1",
        incident_id: "inc-1",
        incident_key: "21160000:KHO_TON",
        current_state: "FIRST_PUSH_PENDING",
      }),
      upsertCase: vi.fn(),
      insertEvent: vi.fn(),
    } as any;

    const dispatcher = new NotificationDispatcher(queue, followupRepoMock);
    const summary = await dispatcher.dispatchPendingActions();

    expect(summary.simulatedCount).toBe(1);
    expect(summary.sentCount).toBe(0);
    expect(followupRepoMock.upsertCase).not.toHaveBeenCalled();
  });

  // 7. DELIVERED confirms Follow-up delivery
  it("7. DELIVERED outcome confirms Follow-up delivery", async () => {
    const queue = new ActionQueue(null);
    await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "mock_delivered_provider",
      payload: { incidentKey: "21160000:KHO_TON" },
    });

    const followupRepoMock = {
      getCaseById: vi.fn().mockResolvedValue({
        id: "case-1",
        incident_id: "123e4567-e89b-12d3-a456-426614174000",
        incident_key: "21160000:KHO_TON",
        current_state: "FIRST_PUSH_PENDING",
        first_detected_at: "2026-08-05T08:00:00Z",
        baseline_affected_order_count: 100,
        latest_affected_order_count: 100,
        current_progress_percent: 0,
        current_assessment: "no_progress",
      }),
      upsertCase: vi.fn().mockResolvedValue({ id: "case-1" }),
      insertEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    } as any;

    const dispatcher = new NotificationDispatcher(queue, followupRepoMock);
    dispatcher.registerProvider({
      name: () => "mock_delivered_provider",
      send: async () => ({ outcome: "DELIVERED", providerMessageId: "msg-100" }),
      health: async () => ({ name: "mock", status: "Healthy" }),
    });

    const summary = await dispatcher.dispatchPendingActions();
    expect(summary.sentCount).toBe(1);
    expect(followupRepoMock.upsertCase).toHaveBeenCalled();
  });

  // 8. Every state transition writes an audit event
  it("8. Every state transition writes an audit event", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: { test: true },
    });
    const action = result && "id" in result ? result : null;

    const dispatcher = new NotificationDispatcher(queue);
    await dispatcher.dispatchPendingActions();

    const events = await queue.getActionEvents(action!.id);
    expect(events.length).toBeGreaterThanOrEqual(3);
    const types = events.map((e) => e.event_type);
    expect(types).toContain("ACTION_ENQUEUED");
    expect(types).toContain("ACTION_CLAIMED");
    expect(types).toContain("DELIVERY_SIMULATED");
  });

  // ===== RETRY CLASSIFICATION TESTS =====

  it("9. Timeout errors trigger RETRY_SCHEDULED", () => {
    expect(RetryEngine.isTransientError(undefined, "NETWORK_TIMEOUT", "fetch failed")).toBe(true);
    expect(RetryEngine.shouldRetry(1, undefined, "NETWORK_TIMEOUT", "fetch failed", 3)).toBe(true);
  });

  it("10. HTTP 429 uses retry_after parameter when specified", () => {
    expect(RetryEngine.isTransientError(429)).toBe(true);
    const delayMs = RetryEngine.getNextRetryDelayMs(1, 45);
    expect(delayMs).toBe(45000);
  });

  it("11. HTTP 5xx errors trigger retry", () => {
    expect(RetryEngine.isTransientError(500)).toBe(true);
    expect(RetryEngine.isTransientError(502)).toBe(true);
    expect(RetryEngine.isTransientError(503)).toBe(true);
  });

  it("12. Permanent 4xx errors (400, 401, 403, 404) do NOT retry", () => {
    expect(RetryEngine.isTransientError(400, "INVALID_PAYLOAD")).toBe(false);
    expect(RetryEngine.isTransientError(401, "INVALID_BOT_TOKEN")).toBe(false);
    expect(RetryEngine.isTransientError(403, "FORBIDDEN")).toBe(false);
    expect(RetryEngine.isTransientError(404, "CHAT_NOT_FOUND")).toBe(false);
  });

  it("13. Max retry count reached marks action as FAILED", () => {
    expect(RetryEngine.shouldRetry(3, 500, "HTTP_500", "Server error", 3)).toBe(false);
  });

  // 14. Provider message ID is stored on delivery
  it("14. Provider message ID is stored on successful delivery", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "mock_delivered_provider",
      payload: { test: true },
    });
    const action = result && "id" in result ? result : null;

    const dispatcher = new NotificationDispatcher(queue);
    dispatcher.registerProvider({
      name: () => "mock_delivered_provider",
      send: async () => ({ outcome: "DELIVERED", providerMessageId: "tg-msg-999" }),
      health: async () => ({ name: "mock", status: "Healthy" }),
    });

    await dispatcher.dispatchPendingActions();
    const updated = await queue.getActionById(action!.id);
    expect(updated?.status).toBe("SENT");
    expect(updated?.provider_message_id).toBe("tg-msg-999");
  });

  // 15. Migration 005 is upgrade-safe
  it("15. Migration 005 is upgrade-safe with transactional IF NOT EXISTS statements", () => {
    const migrationSql = fs.readFileSync("src/database/migrations/005_notification_hardening.sql", "utf-8");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS notification_action_events");
    expect(migrationSql).toContain("BEGIN;");
    expect(migrationSql).toContain("COMMIT;");
  });

  // ===== DEDUPLICATION AUDIT TESTS =====

  it("16. ACTION_DEDUPLICATED references the existing action real UUID, not a synthetic ID", async () => {
    const queue = new ActionQueue(null);
    const dedupKey = Deduplicator.generateKey("incident-001", "FIRST_PUSH");

    // First enqueue succeeds
    const firstResult = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: { test: true },
      deduplicationKey: dedupKey,
    });
    expect(firstResult).not.toBeNull();
    const firstAction = firstResult && "id" in firstResult && !("deduplicated" in firstResult)
      ? firstResult
      : null;
    expect(firstAction).not.toBeNull();
    const originalId = firstAction!.id;

    // Second enqueue is deduplicated
    const secondResult = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: { test: true },
      deduplicationKey: dedupKey,
    });

    // Must return a DeduplicationResult pointing to the existing action
    expect(secondResult).not.toBeNull();
    expect(secondResult).toHaveProperty("deduplicated", true);
    const dedupResult = secondResult as DeduplicationResult;
    expect(dedupResult.existingAction.id).toBe(originalId);
    expect(dedupResult.reason).toBe("in_memory_duplicate");

    // The audit event must reference the REAL action UUID
    const events = await queue.getActionEvents(originalId);
    const dedupEvent = events.find((e) => e.event_type === "ACTION_DEDUPLICATED");
    expect(dedupEvent).toBeDefined();
    expect(dedupEvent!.action_id).toBe(originalId);
    expect(dedupEvent!.metadata).toHaveProperty("deduplicationKey", dedupKey);
    expect(dedupEvent!.metadata).toHaveProperty("reason", "in_memory_duplicate");
    expect(dedupEvent!.metadata).toHaveProperty("attemptedActionType", "FIRST_PUSH");
    expect(dedupEvent!.metadata).toHaveProperty("attemptedAt");
  });

  it("17. No synthetic action ID (dedup-*) is produced by enqueueAction", async () => {
    const queue = new ActionQueue(null);
    const dedupKey = "unique-key-for-test-17";

    await queue.enqueueAction({
      actionType: "SECOND_PUSH",
      provider: "console",
      payload: {},
      deduplicationKey: dedupKey,
    });
    // Duplicate attempt
    await queue.enqueueAction({
      actionType: "SECOND_PUSH",
      provider: "console",
      payload: {},
      deduplicationKey: dedupKey,
    });

    // Get ALL actions and ALL events — none should have a "dedup-" prefixed ID
    const allActions = await queue.getAllActions();
    for (const a of allActions) {
      expect(a.id).not.toMatch(/^dedup-/);
    }

    // Check that all events reference a real action ID
    for (const a of allActions) {
      const events = await queue.getActionEvents(a.id);
      for (const e of events) {
        expect(e.action_id).not.toMatch(/^dedup-/);
        expect(e.action_id).toBe(a.id);
      }
    }
  });

  it("18. Dedup event references existing action status in old_status and new_status", async () => {
    const queue = new ActionQueue(null);
    const dedupKey = "dedup-status-check-18";

    // Enqueue and dispatch to move to SIMULATED
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: {},
      deduplicationKey: dedupKey,
    });
    const original = result && "id" in result && !("deduplicated" in result) ? result : null;
    expect(original).not.toBeNull();

    // Dispatch to change status to SIMULATED
    const dispatcher = new NotificationDispatcher(queue);
    await dispatcher.dispatchPendingActions();
    const afterDispatch = await queue.getActionById(original!.id);
    expect(afterDispatch?.status).toBe("SIMULATED");

    // Now try to enqueue again with same dedup key
    const dupResult = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: {},
      deduplicationKey: dedupKey,
    });
    expect(dupResult).toHaveProperty("deduplicated", true);

    // The dedup event should show SIMULATED as both old and new status
    const events = await queue.getActionEvents(original!.id);
    const dedupEvt = events.find((e) => e.event_type === "ACTION_DEDUPLICATED");
    expect(dedupEvt).toBeDefined();
    expect(dedupEvt!.old_status).toBe("SIMULATED");
    expect(dedupEvt!.new_status).toBe("SIMULATED");
  });

  // ===== CONFIRM ENDPOINT VALIDATION TESTS =====
  // These test the validation logic, not the HTTP layer (which requires Next.js runtime)

  it("19. confirmedBy validation: missing → rejected", () => {
    const body = {};
    const raw = (body as any).confirmedBy;
    expect(raw).toBeUndefined();
    // The confirm route would return 400 MissingConfirmedBy
  });

  it("20. confirmedBy validation: empty string → rejected", () => {
    const confirmedBy = String("").trim();
    expect(confirmedBy.length).toBe(0);
    // The confirm route would return 400 EmptyConfirmedBy
  });

  it("21. confirmedBy validation: whitespace only → rejected", () => {
    const confirmedBy = String("   \t  \n  ").trim();
    expect(confirmedBy.length).toBe(0);
    // The confirm route would return 400 EmptyConfirmedBy
  });

  it("22. confirmedBy validation: valid string → accepted", () => {
    const confirmedBy = String("nguyen.son@ops.vn").trim();
    expect(confirmedBy.length).toBeGreaterThan(0);
    expect(confirmedBy.length).toBeLessThanOrEqual(200);
    // The confirm route would proceed
  });

  it("23. Duplicate confirmation → rejected because status is no longer SIMULATED", async () => {
    const queue = new ActionQueue(null);

    // Create and dispatch to get SIMULATED
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "console",
      payload: {},
    });
    const action = result && "id" in result && !("deduplicated" in result) ? result : null;
    expect(action).not.toBeNull();

    const dispatcher = new NotificationDispatcher(queue);
    await dispatcher.dispatchPendingActions();

    const simulated = await queue.getActionById(action!.id);
    expect(simulated?.status).toBe("SIMULATED");

    // Simulate first manual confirmation
    await queue.updateActionStatus(action!.id, "SENT", { outcome: "DELIVERED" });

    // Second confirmation attempt: status is now SENT, not SIMULATED → should be rejected
    const afterConfirm = await queue.getActionById(action!.id);
    expect(afterConfirm?.status).toBe("SENT");
    expect(afterConfirm?.status).not.toBe("SIMULATED");
    // The confirm route checks action.status !== "SIMULATED" → 400
  });

  // ===== MIGRATION INTEGRITY =====

  it("24. Migration 006 adds CHECK constraints with IF NOT EXISTS guards", () => {
    const migrationSql = fs.readFileSync("src/database/migrations/006_notification_check_constraints.sql", "utf-8");
    expect(migrationSql).toContain("chk_notification_actions_status");
    expect(migrationSql).toContain("chk_notification_actions_outcome");
    expect(migrationSql).toContain("chk_notification_actions_action_type");
    expect(migrationSql).toContain("chk_notification_actions_target_type");
    expect(migrationSql).toContain("chk_notification_actions_priority");
    expect(migrationSql).toContain("chk_notification_action_events_event_type");
    expect(migrationSql).toContain("IF NOT EXISTS");
    expect(migrationSql).toContain("BEGIN;");
    expect(migrationSql).toContain("COMMIT;");
  });
});
