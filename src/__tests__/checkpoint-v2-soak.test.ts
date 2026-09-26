import { describe, it, expect } from "vitest";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";
import { CapacityLoadGenerator } from "@/engine/checkpoint-v2/capacity-generator";

describe("Checkpoint Pipeline V2 - 24-Checkpoint Long-Run Soak Test", () => {
  it("simulates 24 consecutive checkpoints with variable volumes, worker timeout, DB transient failure, and Telegram transient failure", async () => {
    const queue = new MockCheckpointWorkQueueRepository();
    const orchestrator = new CheckpointOrchestrator(queue);
    const ledgerStorage = new InMemoryDispatchLedgerStorage();
    const dispatchLedger = new CheckpointDispatchLedger(ledgerStorage);

    const baseTimeMs = new Date("2026-09-26T00:00:00.000Z").getTime();
    const checkpointSummaries = [];

    let totalDispatchesSent = 0;
    let totalDuplicatesPrevented = 0;

    // Simulate 24 consecutive hourly checkpoints
    for (let hour = 1; hour <= 24; hour++) {
      const checkpointAt = new Date(baseTimeMs + hour * 3600_000).toISOString();
      const syncRunId = `run_hour_${hour}_${Math.random().toString(36).substring(2, 7)}`;

      // Variable volumes: base 2,000 orders, spikes up to 15,000 orders at hours 8, 14, 18
      let orderVolume = 2_000 + (hour % 5) * 800;
      if (hour === 8 || hour === 14 || hour === 18) {
        orderVolume = 12_000 + (hour === 14 ? 3_000 : 0); // High spike
      }

      // Initialize checkpoint work units
      await orchestrator.initializeCheckpoint(checkpointAt, syncRunId, orderVolume);

      // Injections:
      // Hour 6: Worker timeout injection
      // Hour 12: DB transient error injection
      // Hour 16: Telegram transient error injection
      const isTimeoutHour = hour === 6;
      const isDbTransientHour = hour === 12;
      const isTelegramTransientHour = hour === 16;

      let injectedTimeoutTriggered = false;
      let injectedDbErrorTriggered = false;
      let injectedTelegramErrorTriggered = false;

      // Run worker 1
      const worker1 = new CheckpointWorker(queue, {
        softBudgetMs: isTimeoutHour ? 5_000 : 60_000,
        warningBudgetMs: 90_000,
        criticalBudgetMs: 150_000,
        platformCeilingMs: 300_000,
        leaseDurationMs: 60_000,
      }, `soak_worker_h${hour}_1`);

      try {
        await worker1.runLoop(checkpointAt, syncRunId, async (unit) => {
          if (isTimeoutHour && !injectedTimeoutTriggered) {
            injectedTimeoutTriggered = true;
            throw new Error("SIMULATED_WORKER_TIMEOUT_CRASH");
          }
          if (isDbTransientHour && !injectedDbErrorTriggered) {
            injectedDbErrorTriggered = true;
            const err: any = new Error("connection timeout to Supabase");
            err.code = "PGRST_CONNECTION_TIMEOUT";
            err.retryable = true;
            throw err;
          }
          return { itemsProcessed: unit.cursor.limit };
        });
      } catch (err: any) {
        // Crash caught in soak harness
      }

      // If crash/timeout occurred, simulate lease recovery
      if (isTimeoutHour || isDbTransientHour) {
        queue.expireAllLeases();
      }

      // Run worker 2 (recovery / completion worker)
      const worker2 = new CheckpointWorker(queue, undefined, `soak_worker_h${hour}_2`);
      await worker2.runLoop(checkpointAt, syncRunId, async (unit) => {
        return { itemsProcessed: unit.cursor.limit };
      });

      // Dispatch simulation with potential Telegram transient error
      const caseId = `case_h${hour}_1`;
      let attempt = 0;
      const dispatchResult = await dispatchLedger.dispatchEffectivelyOnce({
        checkpointAt,
        syncRunId,
        caseId,
        incidentKey: `KEY_${caseId}`,
        interventionType: "FIRST_PUSH",
        sendExternal: async () => {
          attempt++;
          if (isTelegramTransientHour && attempt === 1 && !injectedTelegramErrorTriggered) {
            injectedTelegramErrorTriggered = true;
            throw new Error("ETIMEDOUT: Telegram gateway transient timeout");
          }
          totalDispatchesSent++;
          return { telegramMessageId: `tg_h${hour}` };
        },
      });

      // If initial dispatch failed, retry
      if (dispatchResult.status === "FAILED") {
        const retryResult = await dispatchLedger.dispatchEffectivelyOnce({
          checkpointAt,
          syncRunId,
          caseId,
          incidentKey: `KEY_${caseId}`,
          interventionType: "FIRST_PUSH",
          sendExternal: async () => {
            totalDispatchesSent++;
            return { telegramMessageId: `tg_h${hour}_retry` };
          },
        });
        expect(retryResult.status).toBe("SENT");
      }

      // Second identical call must be deduplicated
      const dedupCheck = await dispatchLedger.dispatchEffectivelyOnce({
        checkpointAt,
        syncRunId,
        caseId,
        incidentKey: `KEY_${caseId}`,
        interventionType: "FIRST_PUSH",
        sendExternal: async () => {
          totalDispatchesSent++;
          return { telegramMessageId: `tg_h${hour}_dup` };
        },
      });
      if (dedupCheck.status === "DEDUPLICATED") {
        totalDuplicatesPrevented++;
      }

      // Checkpoint completion verification
      const snap = await queue.getObservabilitySnapshot(checkpointAt, syncRunId);
      expect(snap.pendingUnits).toBe(0);
      expect(snap.leasedUnits).toBe(0);
      expect(snap.failedUnits).toBe(0);
      checkpointSummaries.push(snap);
    }

    // Invariants across all 24 checkpoints:
    expect(checkpointSummaries).toHaveLength(24);
    expect(totalDispatchesSent).toBe(24); // Exactly 1 message per checkpoint
    expect(totalDuplicatesPrevented).toBe(24); // Exactly 24 duplicates prevented
    expect(checkpointSummaries.every((s) => !s.isStalled)).toBe(true);
  });
});
