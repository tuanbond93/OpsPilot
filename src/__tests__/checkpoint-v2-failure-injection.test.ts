import { describe, it, expect } from "vitest";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";
import type { CheckpointWorkUnit } from "@/domain/checkpoint-v2/types";

describe("Checkpoint Pipeline V2 - Deterministic Chaos & Failure Injection Suite", () => {
  const checkpointAt = "2026-09-26T07:00:00.000Z";
  const syncRunId = "6c6b3a71-8df7-4042-8e30-659767b723e7";

  it("converges with zero duplicates when worker crashes halfway through population chunks", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    const orchestrator = new CheckpointOrchestrator(queue);

    // 10,000 orders split into 10 chunks of 1,000
    const createdUnits = await orchestrator.initializeCheckpoint(checkpointAt, syncRunId, 10_000);
    expect(createdUnits).toBe(10);

    const persistedChunks: string[] = [];

    // Worker 1: Crashes after processing 4 chunks
    let processedByWorker1 = 0;
    const worker1 = new CheckpointWorker(queue, {
      softBudgetMs: 50_000,
      warningBudgetMs: 80_000,
      criticalBudgetMs: 120_000,
      platformCeilingMs: 300_000,
      leaseDurationMs: 60_000,
    }, "worker-1");

    await expect(
      worker1.runLoop(checkpointAt, syncRunId, async (unit) => {
        if (processedByWorker1 >= 4) {
          throw new Error("SIMULATED_SIGKILL_WORKER_CRASH");
        }
        persistedChunks.push(unit.partitionKey);
        processedByWorker1++;
        return { itemsProcessed: unit.cursor.limit };
      })
    ).rejects.toThrow("SIMULATED_SIGKILL_WORKER_CRASH");

    expect(persistedChunks).toHaveLength(4);

    const snap1 = await queue.getObservabilitySnapshot(checkpointAt, syncRunId);
    expect(snap1.completedUnits).toBe(4);

    // Simulate worker crash: lease expires
    queue.expireAllLeases();

    // Worker 2: Resumes execution of the remaining chunks
    const worker2 = new CheckpointWorker(queue, {
      softBudgetMs: 60_000,
      warningBudgetMs: 90_000,
      criticalBudgetMs: 150_000,
      platformCeilingMs: 300_000,
      leaseDurationMs: 60_000,
    }, "worker-2");

    await worker2.runLoop(checkpointAt, syncRunId, async (unit) => {
      persistedChunks.push(unit.partitionKey);
      return { itemsProcessed: unit.cursor.limit };
    });

    // Verify all 10 chunks are completed without repeating already-completed chunks
    const snap2 = await queue.getObservabilitySnapshot(checkpointAt, syncRunId);
    expect(snap2.completedUnits).toBe(10);
    expect(snap2.pendingUnits).toBe(0);
    expect(snap2.failedUnits).toBe(0);

    // Exactly 10 unique partitions were committed
    const uniqueCommitted = new Set(persistedChunks);
    expect(uniqueCommitted.size).toBe(10);
  });

  it("converges cleanly when worker crashes after member generation PREPARING before COMMITTED", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    const generationStore = new Map<string, { status: "PREPARING" | "COMMITTED"; members: string[] }>();

    // Create 3 member persistence work units
    await queue.createWorkUnits([
      {
        checkpointAt,
        syncRunId,
        stage: "FOLLOWUPS_PROCESSING",
        workType: "PERSIST_MEMBERS_CHUNK",
        partitionKey: "gen_case_1",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: `${checkpointAt}:${syncRunId}:gen_case_1`,
      },
      {
        checkpointAt,
        syncRunId,
        stage: "FOLLOWUPS_PROCESSING",
        workType: "PERSIST_MEMBERS_CHUNK",
        partitionKey: "gen_case_2",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: `${checkpointAt}:${syncRunId}:gen_case_2`,
      },
    ]);

    // Worker 1 starts case 1, sets PREPARING, then crashes
    const worker1 = new CheckpointWorker(queue, undefined, "worker-1");
    await expect(
      worker1.runLoop(checkpointAt, syncRunId, async (unit) => {
        generationStore.set(unit.partitionKey, { status: "PREPARING", members: ["ORD_A", "ORD_B"] });
        throw new Error("SIMULATED_CRASH_MID_MEMBER_PERSISTENCE");
      })
    ).rejects.toThrow("SIMULATED_CRASH_MID_MEMBER_PERSISTENCE");

    expect(generationStore.get("gen_case_1")?.status).toBe("PREPARING");


    // Expire lease
    queue.expireAllLeases();

    // Worker 2 recovers: idempotent re-entry commits the generation
    const worker2 = new CheckpointWorker(queue, undefined, "worker-2");
    await worker2.runLoop(checkpointAt, syncRunId, async (unit) => {
      // Re-entry is idempotent: completes members and advances status to COMMITTED
      generationStore.set(unit.partitionKey, { status: "COMMITTED", members: ["ORD_A", "ORD_B"] });
      return { itemsProcessed: 2 };
    });

    expect(generationStore.get("gen_case_1")?.status).toBe("COMMITTED");
    expect(generationStore.get("gen_case_2")?.status).toBe("COMMITTED");

    const snap = await queue.getObservabilitySnapshot(checkpointAt, syncRunId);
    expect(snap.completedUnits).toBe(2);
    expect(snap.failedUnits).toBe(0);
  });

  it("prevents duplicate Telegram messages when worker crashes immediately after external Telegram delivery", async () => {
    const storage = new InMemoryDispatchLedgerStorage();
    const ledger = new CheckpointDispatchLedger(storage);

    let externalTelegramSendCount = 0;
    const fakeSendTelegram = async () => {
      externalTelegramSendCount++;
      return { telegramMessageId: "tg_msg_778899" };
    };

    const caseId = "case-uuid-1001";
    const incidentKey = "20950000:KHO_TON";

    // Attempt 1: Telegram succeeds, but process is killed immediately before caller gets return
    const result1 = await ledger.dispatchEffectivelyOnce({
      checkpointAt,
      syncRunId,
      caseId,
      incidentKey,
      interventionType: "FIRST_PUSH",
      sequence: 1,
      sendExternal: fakeSendTelegram,
    });

    expect(result1.status).toBe("SENT");
    expect(result1.messageId).toBe("tg_msg_778899");
    expect(externalTelegramSendCount).toBe(1);

    // Attempt 2: Worker retry for same intervention
    const result2 = await ledger.dispatchEffectivelyOnce({
      checkpointAt,
      syncRunId,
      caseId,
      incidentKey,
      interventionType: "FIRST_PUSH",
      sequence: 1,
      sendExternal: fakeSendTelegram,
    });

    // Invariant: externalTelegramSendCount remains 1, message is deduplicated
    expect(result2.status).toBe("DEDUPLICATED");
    expect(result2.messageId).toBe("tg_msg_778899");
    expect(externalTelegramSendCount).toBe(1);
  });
});
