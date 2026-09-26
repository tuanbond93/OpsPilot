import { describe, expect, it, vi } from "vitest";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import type { WorkerBudgetConfig } from "@/domain/checkpoint-v2/types";

describe("Checkpoint Pipeline V2 - Worker Soft Budget Hardening & Overshoot Prevention", () => {
  const CHECKPOINT_AT = "2026-09-26T14:00:00.000Z";
  const SYNC_RUN_ID = "6c6b3a71-8df7-4042-8e30-659767b723e7";

  it("stops starting new work units when remaining budget is below safeTailMarginMs", async () => {
    const queueRepo = new MockCheckpointWorkQueueRepository();

    // Enqueue 5 work units
    await queueRepo.createWorkUnits(
      Array.from({ length: 5 }, (_, i) => ({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: `chunk_${i}`,
        cursor: { offset: i * 500, limit: 500 },
        idempotencyKey: `unit_${i}`,
      }))
    );

    // Hardened budget: softBudgetMs = 100ms, safeTailMarginMs = 40ms.
    // Safe threshold is at elapsed >= 60ms.
    const customBudget: WorkerBudgetConfig = {
      softBudgetMs: 100,
      safeTailMarginMs: 40,
      warningBudgetMs: 150,
      criticalBudgetMs: 200,
      platformCeilingMs: 300_000,
      leaseDurationMs: 60_000,
    };

    const worker = new CheckpointWorker(queueRepo, customBudget, "test-budget-worker");

    const executedUnits: string[] = [];

    // Unit 0 takes 70ms. At completion, elapsed is 70ms.
    // Remaining time = 100 - 70 = 30ms, which is <= safeTailMarginMs (40ms).
    // The worker must NOT start unit 1 or any subsequent units!
    const summary = await worker.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async (unit) => {
      executedUnits.push(unit.id);
      await new Promise((r) => setTimeout(r, 70));
      return { itemsProcessed: 500 };
    });

    // Verify only the first unit was executed
    expect(executedUnits).toHaveLength(1);
    expect(summary.workUnitsCompleted).toBe(1);
    expect(summary.softBudgetYielded).toBe(true);

    // Total invocation must not overshoot into critical window
    expect(summary.invocationDurationMs).toBeLessThan(120);

    // Verify unstarted units in the batch were cleanly released back to PENDING (not stuck in LEASED)
    const allUnits = await queueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT);
    const completedUnits = allUnits.filter((u) => u.status === "COMPLETED");
    const pendingUnits = allUnits.filter((u) => u.status === "PENDING");
    const leasedUnits = allUnits.filter((u) => u.status === "LEASED");

    expect(completedUnits).toHaveLength(1);
    expect(pendingUnits).toHaveLength(4);
    expect(leasedUnits).toHaveLength(0); // Zero stuck leased units!
  });

  it("continuation invocation seamlessly picks up unstarted released units", async () => {
    const queueRepo = new MockCheckpointWorkQueueRepository();

    await queueRepo.createWorkUnits(
      Array.from({ length: 3 }, (_, i) => ({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: `chunk_${i}`,
        cursor: { offset: i * 500, limit: 500 },
        idempotencyKey: `unit_${i}`,
      }))
    );

    const customBudget: WorkerBudgetConfig = {
      softBudgetMs: 100,
      safeTailMarginMs: 40,
      warningBudgetMs: 150,
      criticalBudgetMs: 200,
      platformCeilingMs: 300_000,
      leaseDurationMs: 60_000,
    };

    // Invocation 1: executes unit 0, releases unit 1 & 2
    const worker1 = new CheckpointWorker(queueRepo, customBudget, "worker-1");
    const summary1 = await worker1.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async () => {
      await new Promise((r) => setTimeout(r, 70));
      return { itemsProcessed: 500 };
    });
    expect(summary1.workUnitsCompleted).toBe(1);
    expect(summary1.softBudgetYielded).toBe(true);

    // Invocation 2 (continuation): immediately claims unit 1, executes, and yields
    const worker2 = new CheckpointWorker(queueRepo, customBudget, "worker-2");
    const summary2 = await worker2.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async () => {
      await new Promise((r) => setTimeout(r, 70));
      return { itemsProcessed: 500 };
    });
    expect(summary2.workUnitsCompleted).toBe(1);
    expect(summary2.softBudgetYielded).toBe(true);

    // Invocation 3 (continuation): claims and completes final unit 2
    const worker3 = new CheckpointWorker(queueRepo, customBudget, "worker-3");
    const summary3 = await worker3.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { itemsProcessed: 500 };
    });
    expect(summary3.workUnitsCompleted).toBe(1);

    const allUnits = await queueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT);
    expect(allUnits.every((u) => u.status === "COMPLETED")).toBe(true);
  });
});
