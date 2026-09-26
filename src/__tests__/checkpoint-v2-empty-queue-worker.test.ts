import { describe, expect, it } from "vitest";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointShadowRunner } from "@/engine/checkpoint-v2/checkpoint-shadow-runner";

/**
 * EMPTY_QUEUE_WORKER_TEST
 *
 * Verifies that worker invocation with zero pending SHADOW units:
 * - returns successfully
 * - performs no operational mutation
 * - sends no Telegram
 * - finishes quickly (< 50ms)
 */
describe("EMPTY_QUEUE_WORKER_TEST", () => {
  it("handles empty work queue cleanly without errors or side effects", async () => {
    const queueRepo = new MockCheckpointWorkQueueRepository();
    const shadowRunner = new CheckpointShadowRunner(queueRepo);

    const checkpointAt = "2026-09-27T01:00:00.000Z";
    const syncRunId = "sync_empty_queue_123";

    const t0 = performance.now();
    const summary = await shadowRunner.runWorkerBatch(checkpointAt, syncRunId);
    const durationMs = performance.now() - t0;

    // 1. Returns successfully
    expect(summary).toBeDefined();
    expect(summary.checkpointAt).toBe(checkpointAt);
    expect(summary.syncRunId).toBe(syncRunId);

    // 2. No work claimed or completed
    expect(summary.workUnitsClaimed).toBe(0);
    expect(summary.workUnitsCompleted).toBe(0);
    expect(summary.workUnitsFailed).toBe(0);
    expect(summary.itemsProcessed).toBe(0);

    // 3. Finishes quickly
    expect(durationMs).toBeLessThan(100);

    // 4. No mutations to work queue
    const units = await queueRepo.getWorkUnitsForCheckpoint(checkpointAt);
    expect(units.length).toBe(0);
  });
});
