import { describe, expect, it, vi } from "vitest";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";

/**
 * REPRODUCER TEST: SIGKILL-Style Separate Process Recovery Test
 *
 * Simulates:
 * 1. Checkpoint reaches durable barrier
 * 2. Shadow durable units are persisted in queue repo
 * 3. V1 process terminates immediately after kickoff (simulated SIGKILL / process death)
 * 4. A separate worker process/invocation starts later
 * 5. It claims and completes the existing SHADOW units
 *
 * Proves:
 * - no dependence on in-memory state
 * - no reseeding requirement
 * - no cross-checkpoint adoption
 * - no external Telegram calls
 */
describe("SEPARATE_PROCESS_RECOVERY_TEST", () => {
  const CHECKPOINT_AT_TARGET = "2026-09-27T01:00:00.000Z";
  const SYNC_RUN_ID_TARGET = "run_08h_target_123";

  const CHECKPOINT_AT_OTHER = "2026-09-26T13:00:00.000Z";
  const SYNC_RUN_ID_OTHER = "run_20h_other_456";

  it("proves a completely separate worker process can claim and finish existing SHADOW units without in-memory state or reseeding", async () => {
    // Shared durable backing store (simulates PostgreSQL / Supabase)
    const durableQueueRepo = new MockCheckpointWorkQueueRepository();

    // 0. Seed a foreign/earlier checkpoint to test cross-checkpoint isolation
    const foreignOrchestrator = new CheckpointOrchestrator(durableQueueRepo);
    await foreignOrchestrator.initializeCheckpoint(
      CHECKPOINT_AT_OTHER,
      SYNC_RUN_ID_OTHER,
      2000,
      "SHADOW"
    );

    // 1. Checkpoint reaches durable barrier in V1 process
    // V1 process creates durable work units
    let v1ProcessMemory: any = {
      ordersInMemory: Array.from({ length: 5000 }, (_, i) => ({ id: `ord_${i}` })),
      temporaryBuffers: new ArrayBuffer(1024),
      activeSocket: { connected: true },
    };

    const v1Orchestrator = new CheckpointOrchestrator(durableQueueRepo);
    const persistedUnitsCount = await v1Orchestrator.initializeCheckpoint(
      CHECKPOINT_AT_TARGET,
      SYNC_RUN_ID_TARGET,
      v1ProcessMemory.ordersInMemory.length,
      "SHADOW"
    );

    expect(persistedUnitsCount).toBe(5); // 5000 / 1000 = 5 units

    // Verify units are durably persisted with status = PENDING and execution_mode = SHADOW
    const initialUnits = await durableQueueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT_TARGET);
    expect(initialUnits.length).toBe(5);
    expect(initialUnits.every((u) => u.status === "PENDING")).toBe(true);
    expect(initialUnits.every((u) => u.executionMode === "SHADOW")).toBe(true);

    // 2. SIMULATE IMMEDIATE V1 PROCESS DEATH (SIGKILL / Out-Of-Memory / 300s timeout)
    // Destroy all V1 in-memory state and references completely
    v1ProcessMemory = null;
    let v1OrchestratorRef: any = v1Orchestrator;
    v1OrchestratorRef = null;

    // 3. A SEPARATE WORKER PROCESS STARTS LATER
    // New worker instance, new worker ID, no access to v1ProcessMemory, NO call to initializeCheckpoint!
    let externalTelegramCalls = 0;
    const separateWorkerStorage = new InMemoryDispatchLedgerStorage();
    const separateShadowLedger = new CheckpointDispatchLedger(separateWorkerStorage);

    const separateWorker = new CheckpointWorker(
      durableQueueRepo,
      undefined,
      "worker_separate_process"
    );

    // Track processed units in separate worker
    const processedUnitIds: string[] = [];

    // Worker loop runs for CHECKPOINT_AT_TARGET in SHADOW mode
    const summary = await separateWorker.runLoop(
      CHECKPOINT_AT_TARGET,
      SYNC_RUN_ID_TARGET,
      async (unit) => {
        processedUnitIds.push(unit.id);

        // Verify dispatch evaluation in shadow mode hard-blocks external Telegram calls
        await separateShadowLedger.dispatchEffectivelyOnce({
          checkpointAt: unit.checkpointAt,
          syncRunId: unit.syncRunId,
          caseId: `case_${unit.id}`,
          incidentKey: `WH:${unit.id}`,
          interventionType: "TELEGRAM_FIRST_PUSH",
          executionMode: "SHADOW",
          sendExternal: async () => {
            externalTelegramCalls++;
            throw new Error("SECURITY_BREACH: External dispatch occurred in SHADOW mode");
          },
        });

        return { itemsProcessed: unit.cursor.limit };
      },
      "SHADOW"
    );

    // 4. VERIFY INDEPENDENT RECOVERY & EXECUTION INVARIANTS

    // Invariant A: Completed all units without needing in-memory state from V1
    expect(summary.workUnitsClaimed).toBe(5);
    expect(summary.workUnitsCompleted).toBe(5);
    expect(summary.workUnitsFailed).toBe(0);
    expect(summary.itemsProcessed).toBe(5000);
    expect(processedUnitIds.length).toBe(5);

    // Invariant B: No reseeding requirement (all original unit IDs were completed)
    const finalUnits = await durableQueueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT_TARGET);
    expect(finalUnits.length).toBe(5);
    expect(finalUnits.every((u) => u.status === "COMPLETED")).toBe(true);

    // Invariant C: Strict Checkpoint Scoping - NO cross-checkpoint adoption
    const otherUnits = await durableQueueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT_OTHER);
    expect(otherUnits.length).toBe(2); // 2000 / 1000 = 2 units
    expect(otherUnits.every((u) => u.status === "PENDING")).toBe(true);
    expect(otherUnits.some((u) => u.leaseOwner === separateWorker.workerId)).toBe(false);

    // Invariant D: Zero external Telegram calls
    expect(externalTelegramCalls).toBe(0);
  });
});
