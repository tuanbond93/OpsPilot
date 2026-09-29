import { describe, expect, it, vi } from "vitest";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import type { CheckpointWorkUnit } from "@/domain/checkpoint-v2/types";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import {
  decideV1FinalizerAction,
  seedFinalizerIfDrained,
} from "@/services/durable-v1-worker";

const checkpointAt = "2026-09-29T13:00:00.000Z";
const syncRunId = "20h-fault-contained-test";

function unit(
  index: number,
  status: CheckpointWorkUnit["status"],
  executionMode: "PRODUCTION" | "SHADOW" = "PRODUCTION",
): any {
  return {
    id: `${executionMode.toLowerCase()}-unit-${index}`,
    checkpoint_at: checkpointAt,
    sync_run_id: syncRunId,
    stage: "FOLLOWUPS_PROCESSING",
    work_type: "EVALUATE_FOLLOWUP_BATCH",
    partition_key: `v1_followup_${index}`,
    cursor: { metadata: { pipelineVersion: "V1", chunkIndex: index } },
    status,
    execution_mode: executionMode,
    attempts: status === "FAILED" ? 3 : 1,
    max_attempts: 3,
    idempotency_key: `${checkpointAt}:${syncRunId}:${executionMode}:${index}`,
    created_at: new Date(index).toISOString(),
  };
}

function finalizerClient(
  rows: any[],
  persistedUnitCount: number,
  producerCompletedAt: string | null = checkpointAt,
) {
  const updates: any[] = [];
  const finalizerRows: any[] = [];
  const client: any = {
    from: vi.fn((table: string) => {
      if (table === "checkpoint_work_units") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: rows, error: null }),
            }),
          }),
          upsert: vi.fn((payload: any[]) => {
            finalizerRows.push(...payload);
            return {
              select: vi.fn().mockResolvedValue({
                data: payload.map((_, index) => ({ id: `finalizer-${index}` })),
                error: null,
              }),
            };
          }),
        };
      }

      if (table === "checkpoint_v1_followup_input_chunks") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: persistedUnitCount, error: null }),
          }),
        };
      }

      if (table === "checkpoint_v1_followup_inputs") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { candidate_keys: [], producer_completed_at: producerCompletedAt },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "sync_runs") {
        return {
          update: vi.fn((patch: any) => ({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation(() => {
                updates.push(patch);
                return Promise.resolve({ error: null });
              }),
            }),
          })),
        };
      }

      return {};
    }),
  };
  return { client, updates, finalizerRows };
}

async function createProductionUnits(queue: MockCheckpointWorkQueueRepository, count: number, maxAttempts = 3) {
  await queue.createWorkUnits(Array.from({ length: count }, (_, index) => ({
    checkpointAt,
    syncRunId,
    stage: "FOLLOWUPS_PROCESSING" as const,
    workType: "EVALUATE_FOLLOWUP_BATCH" as const,
    partitionKey: `v1_${index}`,
    cursor: { offset: index, limit: 1, metadata: { pipelineVersion: "V1", chunkIndex: index } },
    idempotencyKey: `${checkpointAt}:${syncRunId}:v1:${index}`,
    executionMode: "PRODUCTION" as const,
    maxAttempts,
  })));
}

describe("B.2.5 fault-contained V1 draining", () => {
  it("TEST 1 — one failure with many pending units does not finalize", async () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, index) => unit(index, "COMPLETED")),
      unit(2, "FAILED"),
      ...Array.from({ length: 45 }, (_, index) => unit(index + 3, "PENDING")),
    ];
    const fixture = finalizerClient(rows, 48);

    await expect(seedFinalizerIfDrained(fixture.client, checkpointAt, syncRunId)).resolves.toBe(false);
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.finalizerRows).toHaveLength(0);
    expect(decideV1FinalizerAction(rows, 48)).toBe("WAIT_FOR_DRAIN");
  });

  it("TEST 2 — an exhausted failed unit is not reclaimed while pending work remains claimable", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    await createProductionUnits(queue, 2, 1);

    const first = await queue.claimWorkUnits(checkpointAt, "worker-1", 60_000, 1, "PRODUCTION");
    expect(first).toHaveLength(1);
    await queue.failWorkUnit(first[0].id, "worker-1", {
      failureCode: "V1_WORK_UNIT_ATTEMPTS_EXHAUSTED",
      message: "simulated terminal failure",
      retryable: false,
    });

    const next = await queue.claimWorkUnits(checkpointAt, "worker-2", 60_000, 1, "PRODUCTION");
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(first[0].id);
    expect((await queue.getWorkUnitsForCheckpoint(checkpointAt)).find(item => item.id === first[0].id)?.status)
      .toBe("FAILED");
  });

  it("TEST 3 — partial terminal failure preserves existing failed semantics", async () => {
    const rows = [
      ...Array.from({ length: 47 }, (_, index) => unit(index, "COMPLETED")),
      unit(47, "FAILED"),
    ];
    const fixture = finalizerClient(rows, 48);

    await expect(seedFinalizerIfDrained(fixture.client, checkpointAt, syncRunId)).resolves.toBe(false);
    expect(fixture.updates).toEqual([{
      status: "failed",
      error_code: "V1_WORK_UNIT_ATTEMPTS_EXHAUSTED",
      error_message: "One or more V1 work units failed after exhausting attempts",
      completed_at: expect.any(String),
    }]);
    expect(decideV1FinalizerAction(rows, 48)).toBe("FINALIZE_FAILED");
  });

  it("TEST 4 — full success seeds the existing finalizer", async () => {
    const rows = Array.from({ length: 48 }, (_, index) => unit(index, "COMPLETED"));
    const fixture = finalizerClient(rows, 48);

    await expect(seedFinalizerIfDrained(fixture.client, checkpointAt, syncRunId)).resolves.toBe(true);
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.finalizerRows).toHaveLength(1);
    expect(decideV1FinalizerAction(rows, 48)).toBe("FINALIZE_SUCCESS");
  });

  it("TEST 5 — transient retry recovery reaches COMPLETED", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    await createProductionUnits(queue, 1, 3);
    let executions = 0;
    const worker = new CheckpointWorker(queue, undefined, "retry-worker");

    await worker.runLoop(checkpointAt, syncRunId, async () => {
      executions++;
      if (executions === 1) throw new Error("TRANSIENT_TEST_FAILURE");
      return { itemsProcessed: 1 };
    }, "PRODUCTION", "V1");

    queue.expireAllLeases();
    await worker.runLoop(checkpointAt, syncRunId, async () => ({ itemsProcessed: 1 }), "PRODUCTION", "V1");

    const state = await queue.getWorkUnitsForCheckpoint(checkpointAt);
    expect(state[0].status).toBe("COMPLETED");
    expect(state[0].attempts).toBe(2);
  });

  it("TEST 6 — repeated finalizer seeding is idempotent at the durable queue boundary", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    const finalizer = {
      checkpointAt,
      syncRunId,
      stage: "FOLLOWUPS_COMPLETE" as const,
      workType: "FINALIZE_V1_CHECKPOINT" as const,
      partitionKey: "v1_finalize",
      cursor: { offset: 0, limit: 1, metadata: { pipelineVersion: "V1" } },
      idempotencyKey: `${checkpointAt}:${syncRunId}:V1:finalize`,
      executionMode: "PRODUCTION" as const,
    };

    expect(await queue.createWorkUnits([finalizer, finalizer])).toBe(1);
    expect(await queue.createWorkUnits([finalizer])).toBe(0);
    expect((await queue.getWorkUnitsForCheckpoint(checkpointAt))).toHaveLength(1);
  });

  it("TEST 7 — shadow units do not block production finalization", async () => {
    const rows = [unit(0, "COMPLETED"), unit(1, "COMPLETED"), unit(0, "PENDING", "SHADOW")];
    const fixture = finalizerClient(rows, 2);

    await expect(seedFinalizerIfDrained(fixture.client, checkpointAt, syncRunId)).resolves.toBe(true);
    expect(fixture.finalizerRows).toHaveLength(1);
  });

  it("TEST 8 — the old 20h shape remains drainable", async () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, index) => unit(index, "COMPLETED")),
      ...Array.from({ length: 2 }, (_, index) => unit(index + 2, "FAILED")),
      ...Array.from({ length: 44 }, (_, index) => unit(index + 4, "PENDING")),
    ];
    const fixture = finalizerClient(rows, 48);

    await expect(seedFinalizerIfDrained(fixture.client, checkpointAt, syncRunId)).resolves.toBe(false);
    expect(fixture.updates).toHaveLength(0);
    expect(decideV1FinalizerAction(rows, 48)).toBe("WAIT_FOR_DRAIN");
  });

  it("staging injected-failure drain — 40 production units all reach terminal state", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    await createProductionUnits(queue, 40, 1);
    let injected = false;
    const worker = new CheckpointWorker(queue, {
      softBudgetMs: 35_000,
      safeTailMarginMs: 5_000,
      warningBudgetMs: 40_000,
      criticalBudgetMs: 45_000,
      platformCeilingMs: 60_000,
      leaseDurationMs: 65_000,
      maxUnitsPerClaim: 1,
    }, "staging-failure-worker");

    await worker.runLoop(checkpointAt, syncRunId, async () => {
      if (!injected) {
        injected = true;
        const error: any = new Error("INJECTED_ATTEMPTS_EXHAUSTED");
        error.retryable = false;
        throw error;
      }
      return { itemsProcessed: 1 };
    }, "PRODUCTION", "V1");

    const state = await queue.getWorkUnitsForCheckpoint(checkpointAt);
    expect(state).toHaveLength(40);
    expect(state.filter(item => item.status === "COMPLETED")).toHaveLength(39);
    expect(state.filter(item => item.status === "FAILED")).toHaveLength(1);
    expect(state.some(item => item.status === "PENDING" || item.status === "LEASED")).toBe(false);
    expect(decideV1FinalizerAction(state, 40)).toBe("FINALIZE_FAILED");
  });

  it("staging clean control — 40 production units finalize successfully", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    await createProductionUnits(queue, 40, 1);
    const worker = new CheckpointWorker(queue, undefined, "staging-clean-worker");

    await worker.runLoop(checkpointAt, syncRunId, async () => ({ itemsProcessed: 1 }), "PRODUCTION", "V1");

    const state = await queue.getWorkUnitsForCheckpoint(checkpointAt);
    expect(state.every(item => item.status === "COMPLETED")).toBe(true);
    expect(decideV1FinalizerAction(state, 40)).toBe("FINALIZE_SUCCESS");
  });
});
