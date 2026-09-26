import { describe, it, expect } from "vitest";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";

describe("Checkpoint Pipeline V2 - Overlap & Isolation Safety Gate", () => {
  const checkpoint14h = "2026-09-26T07:00:00.000Z";
  const run14hId = "run-14h-6c6b3a71";

  const checkpoint18h = "2026-09-26T11:00:00.000Z";
  const run18hId = "run-18h-9999aaaa";

  it("proves checkpoint T and checkpoint T+1 operate concurrently without run adoption or work unit contamination", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    const orchestrator = new CheckpointOrchestrator(queue);

    // 1. Checkpoint 14h enters queue with 5 work units
    await queue.createWorkUnits([
      {
        checkpointAt: checkpoint14h,
        syncRunId: run14hId,
        stage: "FOLLOWUPS_PROCESSING",
        workType: "EVALUATE_FOLLOWUP_BATCH",
        partitionKey: "14h_batch_1",
        cursor: { offset: 0, limit: 10 },
        idempotencyKey: `${checkpoint14h}:${run14hId}:batch_1`,
      },
      {
        checkpointAt: checkpoint14h,
        syncRunId: run14hId,
        stage: "FOLLOWUPS_PROCESSING",
        workType: "EVALUATE_FOLLOWUP_BATCH",
        partitionKey: "14h_batch_2",
        cursor: { offset: 10, limit: 10 },
        idempotencyKey: `${checkpoint14h}:${run14hId}:batch_2`,
      },
    ]);

    // 2. Checkpoint 18h natural trigger begins ingestion with 3 chunks
    await orchestrator.initializeCheckpoint(checkpoint18h, run18hId, 3_000);

    // Verify queue contains units for both checkpoints
    const units14h = await queue.getWorkUnitsForCheckpoint(checkpoint14h);
    const units18h = await queue.getWorkUnitsForCheckpoint(checkpoint18h);
    expect(units14h).toHaveLength(2);
    expect(units18h).toHaveLength(3);

    // 3. Worker for 18h runs
    const worker18h = new CheckpointWorker(queue, undefined, "worker-18h");
    const processedBy18h: string[] = [];

    const summary18h = await worker18h.runLoop(checkpoint18h, run18hId, async (unit) => {
      // Invariant: worker for 18h MUST NEVER receive a 14h unit
      expect(unit.checkpointAt).toBe(checkpoint18h);
      expect(unit.syncRunId).toBe(run18hId);
      processedBy18h.push(unit.id);
      return { itemsProcessed: unit.cursor.limit };
    });

    expect(summary18h.workUnitsCompleted).toBe(3);
    expect(processedBy18h).toHaveLength(3);

    // Invariant: 14h units remain untouched in PENDING state
    const after18hUnits14h = await queue.getWorkUnitsForCheckpoint(checkpoint14h);
    expect(after18hUnits14h.every((u) => u.status === "PENDING")).toBe(true);

    // 4. Worker for 14h runs and completes remaining 14h work
    const worker14h = new CheckpointWorker(queue, undefined, "worker-14h");
    const processedBy14h: string[] = [];

    const summary14h = await worker14h.runLoop(checkpoint14h, run14hId, async (unit) => {
      expect(unit.checkpointAt).toBe(checkpoint14h);
      expect(unit.syncRunId).toBe(run14hId);
      processedBy14h.push(unit.id);
      return { itemsProcessed: unit.cursor.limit };
    });

    expect(summary14h.workUnitsCompleted).toBe(2);
    expect(processedBy14h).toHaveLength(2);

    // Both checkpoints converged cleanly to 100% completion
    const snap14h = await queue.getObservabilitySnapshot(checkpoint14h, run14hId);
    const snap18h = await queue.getObservabilitySnapshot(checkpoint18h, run18hId);
    expect(snap14h.completedUnits).toBe(2);
    expect(snap18h.completedUnits).toBe(3);
  });

  it("proves dispatch deduplication isolates identical case IDs across checkpoints", async () => {
    const storage = new InMemoryDispatchLedgerStorage();
    const ledger = new CheckpointDispatchLedger(storage);

    const commonCaseId = "case-warehouse-ton-01";
    let telegramCount = 0;

    const sender = async () => {
      telegramCount++;
      return { telegramMessageId: `msg_${telegramCount}` };
    };

    // 14h dispatch for case
    const res14h = await ledger.dispatchEffectivelyOnce({
      checkpointAt: checkpoint14h,
      syncRunId: run14hId,
      caseId: commonCaseId,
      incidentKey: "KHO_TON_1",
      interventionType: "FIRST_PUSH",
      sendExternal: sender,
    });
    expect(res14h.status).toBe("SENT");
    expect(telegramCount).toBe(1);

    // 18h dispatch for same case (legitimate next checkpoint intervention)
    const res18h = await ledger.dispatchEffectivelyOnce({
      checkpointAt: checkpoint18h,
      syncRunId: run18hId,
      caseId: commonCaseId,
      incidentKey: "KHO_TON_1",
      interventionType: "FIRST_PUSH",
      sendExternal: sender,
    });
    expect(res18h.status).toBe("SENT");
    expect(telegramCount).toBe(2);

    // Retry of 18h dispatch MUST be deduplicated
    const res18hRetry = await ledger.dispatchEffectivelyOnce({
      checkpointAt: checkpoint18h,
      syncRunId: run18hId,
      caseId: commonCaseId,
      incidentKey: "KHO_TON_1",
      interventionType: "FIRST_PUSH",
      sendExternal: sender,
    });
    expect(res18hRetry.status).toBe("DEDUPLICATED");
    expect(telegramCount).toBe(2); // Invariant: no duplicate message
  });
});
