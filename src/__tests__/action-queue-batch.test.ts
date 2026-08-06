import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActionQueue } from "@/engine/action-queue/queue";
import { Deduplicator } from "@/engine/action-queue/deduplicator";
import type { EnqueueActionParams } from "@/engine/action-queue/types";

describe("Sprint 10.3 — Batch ActionQueue Persistence Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Deduplicator.clearMemory();
  });

  it("1. Multiple unique actions enqueued in batch", async () => {
    const queue = new ActionQueue();

    const params: EnqueueActionParams[] = [
      { actionType: "FIRST_PUSH", targetType: "WAREHOUSE", targetId: "wh-1", deduplicationKey: "key-1", payload: {} },
      { actionType: "SECOND_PUSH", targetType: "WAREHOUSE", targetId: "wh-2", deduplicationKey: "key-2", payload: {} },
      { actionType: "ESCALATION", targetType: "WAREHOUSE", targetId: "wh-3", deduplicationKey: "key-3", payload: {} },
    ];

    const results = await queue.enqueueActionBatch(params);

    expect(results.length).toBe(3);
    expect((results[0] as any).id).toBeDefined();
    expect((results[1] as any).id).toBeDefined();
    expect((results[2] as any).id).toBeDefined();

    const metrics = queue.getMetricsSnapshot();
    expect(metrics.enqueueCalls).toBe(3);
  });

  it("2. Duplicate actions within the same input batch", async () => {
    const queue = new ActionQueue();

    const params: EnqueueActionParams[] = [
      { actionType: "FIRST_PUSH", targetType: "WAREHOUSE", targetId: "wh-1", deduplicationKey: "shared-key", payload: {} },
      { actionType: "FIRST_PUSH", targetType: "WAREHOUSE", targetId: "wh-1", deduplicationKey: "shared-key", payload: {} },
    ];

    const results = await queue.enqueueActionBatch(params);

    expect(results.length).toBe(2);
    expect((results[0] as any).id).toBeDefined();
    expect((results[1] as any).deduplicated).toBe(true);
    expect((results[1] as any).reason).toBe("in_memory_duplicate");
  });

  it("3. Duplicate actions already present in database", async () => {
    const mockSupabase = {
      from: (table: string) => {
        if (table === "notification_actions") {
          return {
            select: () => ({
              in: () =>
                Promise.resolve({
                  data: [
                    {
                      id: "existing-act-100",
                      deduplication_key: "db-key-1",
                      status: "PENDING",
                      provider: "console",
                    },
                  ],
                  error: null,
                }),
            }),
            insert: (arr: any[]) => ({
              select: () =>
                Promise.resolve({
                  data: arr.map((r, idx) => ({ id: `new-act-${idx}`, ...r })),
                  error: null,
                }),
            }),
          };
        }
        if (table === "notification_action_events") {
          return {
            insert: (arr: any[]) => ({
              select: () =>
                Promise.resolve({
                  data: arr.map((e, idx) => ({ id: `evt-${idx}`, ...e })),
                  error: null,
                }),
            }),
          };
        }
        return {};
      },
    } as any;

    const queue = new ActionQueue(mockSupabase);

    const params: EnqueueActionParams[] = [
      { actionType: "FIRST_PUSH", targetType: "WAREHOUSE", targetId: "wh-1", deduplicationKey: "db-key-1", payload: {} },
      { actionType: "SECOND_PUSH", targetType: "WAREHOUSE", targetId: "wh-2", deduplicationKey: "unique-key-2", payload: {} },
    ];

    const results = await queue.enqueueActionBatch(params);

    expect(results.length).toBe(2);
    expect((results[0] as any).deduplicated).toBe(true);
    expect((results[0] as any).existingAction.id).toBe("existing-act-100");
    expect((results[1] as any).id).toBe("new-act-0");
  });

  it("4. Action ordering and audit event ordering match input sequence", async () => {
    const queue = new ActionQueue();

    const params: EnqueueActionParams[] = [
      { actionType: "FIRST_PUSH", deduplicationKey: "key-a", payload: {} },
      { actionType: "SECOND_PUSH", deduplicationKey: "key-b", payload: {} },
      { actionType: "ESCALATION", deduplicationKey: "key-c", payload: {} },
    ];

    const results = await queue.enqueueActionBatch(params);

    expect((results[0] as any).action_type).toBe("FIRST_PUSH");
    expect((results[1] as any).action_type).toBe("SECOND_PUSH");
    expect((results[2] as any).action_type).toBe("ESCALATION");

    const events = await queue.getRecentEvents(10);
    expect(events.length).toBe(3);
  });

  it("5. Idempotent rerun deduplicates all actions on second run", async () => {
    const queue = new ActionQueue();
    const params: EnqueueActionParams[] = [
      { actionType: "FIRST_PUSH", deduplicationKey: "idem-1", payload: {} },
      { actionType: "SECOND_PUSH", deduplicationKey: "idem-2", payload: {} },
    ];

    const run1 = await queue.enqueueActionBatch(params);
    expect((run1[0] as any).id).toBeDefined();

    const run2 = await queue.enqueueActionBatch(params);
    expect((run2[0] as any).deduplicated).toBe(true);
    expect((run2[1] as any).deduplicated).toBe(true);
  });

  it("6. Query count reduction verification (batch vs single-row)", async () => {
    let selectInCalls = 0;
    let insertCalls = 0;
    let eventInsertCalls = 0;

    const mockSupabase = {
      from: (table: string) => {
        if (table === "notification_actions") {
          return {
            select: () => ({
              in: () => {
                selectInCalls++;
                return Promise.resolve({ data: [], error: null });
              },
            }),
            insert: (arr: any[]) => {
              insertCalls++;
              return {
                select: () =>
                  Promise.resolve({
                    data: arr.map((r, idx) => ({ id: `act-${idx}`, ...r })),
                    error: null,
                  }),
              };
            },
          };
        }
        if (table === "notification_action_events") {
          return {
            insert: (arr: any[]) => {
              eventInsertCalls++;
              return {
                select: () =>
                  Promise.resolve({
                    data: arr.map((e, idx) => ({ id: `evt-${idx}`, ...e })),
                    error: null,
                  }),
              };
            },
          };
        }
        return {};
      },
    } as any;

    const queue = new ActionQueue(mockSupabase);
    const params: EnqueueActionParams[] = Array.from({ length: 50 }, (_, i) => ({
      actionType: "FIRST_PUSH",
      deduplicationKey: `batch-key-${i}`,
      payload: {},
    }));

    await queue.enqueueActionBatch(params);

    expect(selectInCalls).toBe(1);
    expect(insertCalls).toBe(1);
    expect(eventInsertCalls).toBe(1);
  });
});
