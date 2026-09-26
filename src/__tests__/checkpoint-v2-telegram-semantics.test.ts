import { describe, expect, it, vi } from "vitest";
import {
  CheckpointDispatchLedger,
  InMemoryDispatchLedgerStorage,
} from "@/engine/checkpoint-v2/dispatch-ledger";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";

describe("Checkpoint Pipeline V2 - Telegram Delivery Semantics & Failure Injections", () => {
  const CHECKPOINT_AT = "2026-09-26T07:00:00.000Z";
  const SYNC_RUN_ID = "test-run-telegram-semantics";
  const CASE_ID = "case_001";
  const INCIDENT_KEY = "WH_HNI_01:KHO_TON";
  const INTERVENTION_TYPE = "TELEGRAM_FIRST_PUSH";

  // --------------------------------------------------------------------------
  // Item 5: Telegram Semantics Proof
  // --------------------------------------------------------------------------
  describe("Item 5: Telegram Delivery Semantics (Scenarios A - D)", () => {
    it("Scenario A: Worker dies before Telegram HTTP request -> retry safely delivers", async () => {
      const storage = new InMemoryDispatchLedgerStorage();
      const ledger = new CheckpointDispatchLedger(storage, { lockTimeoutMs: 100 });
      let telegramCallCount = 0;

      const mockSend = vi.fn().mockImplementation(async () => {
        telegramCallCount++;
        return { telegramMessageId: "msg_101" };
      });

      // Worker 1 reserves, but dies before calling sendExternal
      const key = CheckpointDispatchLedger.buildIdempotencyKey(CHECKPOINT_AT, CASE_ID, INTERVENTION_TYPE, 1);
      await storage.reserve({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sequence: 1,
        idempotencyKey: key,
        status: "RESERVED",
      });

      // Simulate lock timeout expiring (worker died)
      await new Promise((r) => setTimeout(r, 120));

      // Worker 2 runs with RETRY_AT_LEAST_ONCE policy
      const retryLedger = new CheckpointDispatchLedger(storage, {
        lockTimeoutMs: 100,
        staleReservationPolicy: "RETRY_AT_LEAST_ONCE",
      });

      const res = await retryLedger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      expect(res.status).toBe("SENT");
      expect(res.messageId).toBe("msg_101");
      expect(telegramCallCount).toBe(1);
    });

    it("Scenario B: Telegram returns failure -> entry marked FAILED and retryable", async () => {
      const storage = new InMemoryDispatchLedgerStorage();
      const ledger = new CheckpointDispatchLedger(storage);
      let attempts = 0;

      const mockSend = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Telegram 503 Service Unavailable");
        }
        return { telegramMessageId: "msg_202" };
      });

      // Attempt 1: Fails
      const res1 = await ledger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      expect(res1.status).toBe("FAILED");
      expect(res1.error).toContain("503 Service Unavailable");

      // Verify entry status is FAILED
      const key = CheckpointDispatchLedger.buildIdempotencyKey(CHECKPOINT_AT, CASE_ID, INTERVENTION_TYPE, 1);
      const entry = await storage.getByDedupeKey(key);
      expect(entry?.status).toBe("FAILED");

      // Attempt 2: Retry succeeds
      const res2 = await ledger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      expect(res2.status).toBe("SENT");
      expect(res2.messageId).toBe("msg_202");
      expect(attempts).toBe(2);
    });

    it("Scenario C: Telegram succeeds but worker dies BEFORE ledger commit -> Stale Reservation Quarantined", async () => {
      const storage = new InMemoryDispatchLedgerStorage();
      let telegramCallCount = 0;

      const mockSend = vi.fn().mockImplementation(async () => {
        telegramCallCount++;
        return { telegramMessageId: "msg_303" };
      });

      // Worker 1 runs, external delivery succeeds, but crash before ledger.confirm()
      const key = CheckpointDispatchLedger.buildIdempotencyKey(CHECKPOINT_AT, CASE_ID, INTERVENTION_TYPE, 1);
      await storage.reserve({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sequence: 1,
        idempotencyKey: key,
        status: "RESERVED",
      });
      // Telegram actually delivered message msg_303
      await mockSend();

      // Worker 1 crashed here! Ledger remains in 'RESERVED' state!

      // Fast forward past lock timeout (e.g. 50ms)
      const ledger = new CheckpointDispatchLedger(storage, {
        lockTimeoutMs: 50,
        staleReservationPolicy: "QUARANTINE",
      });
      await new Promise((r) => setTimeout(r, 60));

      // Worker 2 retries under QUARANTINE policy
      const res2 = await ledger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      // Crucial: Worker 2 MUST NOT send a second message!
      expect(res2.status).toBe("QUARANTINED");
      expect(res2.error).toContain("AMBIGUOUS_STALE_RESERVATION");
      expect(telegramCallCount).toBe(1); // EXACTLY 1 external call made; zero duplicate spam!
    });

    it("Scenario D: Ledger commits successfully -> subsequent retries deduplicate immediately", async () => {
      const storage = new InMemoryDispatchLedgerStorage();
      const ledger = new CheckpointDispatchLedger(storage);
      let telegramCallCount = 0;

      const mockSend = vi.fn().mockImplementation(async () => {
        telegramCallCount++;
        return { telegramMessageId: "msg_404" };
      });

      // Run 1: Sends and commits
      const res1 = await ledger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      expect(res1.status).toBe("SENT");
      expect(res1.messageId).toBe("msg_404");
      expect(telegramCallCount).toBe(1);

      // Run 2: Retry arrives
      const res2 = await ledger.dispatchEffectivelyOnce({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: CASE_ID,
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sendExternal: mockSend,
      });

      expect(res2.status).toBe("DEDUPLICATED");
      expect(res2.messageId).toBe("msg_404");
      expect(telegramCallCount).toBe(1); // Zero additional calls!
    });

    it("reconciles stale reservations in bulk", async () => {
      const storage = new InMemoryDispatchLedgerStorage();
      const ledger = new CheckpointDispatchLedger(storage);

      // Seed 2 stale reservations
      await storage.reserve({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: "case_stale_1",
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sequence: 1,
        idempotencyKey: "stale_key_1",
        status: "RESERVED",
      });
      await storage.reserve({
        checkpointAt: CHECKPOINT_AT,
        syncRunId: SYNC_RUN_ID,
        caseId: "case_stale_2",
        incidentKey: INCIDENT_KEY,
        interventionType: INTERVENTION_TYPE,
        sequence: 1,
        idempotencyKey: "stale_key_2",
        status: "RESERVED",
      });

      // Wait 20ms and reconcile with 10ms threshold
      await new Promise((r) => setTimeout(r, 20));
      const result = await ledger.reconcileStaleReservations(10);

      expect(result.reconciledCount).toBe(2);
      expect(result.quarantinedKeys).toContain("stale_key_1");
      expect(result.quarantinedKeys).toContain("stale_key_2");
    });
  });

  // --------------------------------------------------------------------------
  // Item 6: Failure Injection Across All Lifecycle Phases
  // --------------------------------------------------------------------------
  describe("Item 6: Real Failure Injections Across Lifecycle Points", () => {
    it("Phase 6A: worker kill immediately after lease claim", async () => {
      const queueRepo = new MockCheckpointWorkQueueRepository();
      const orchestrator = new CheckpointOrchestrator(queueRepo);
      await orchestrator.initializeCheckpoint(CHECKPOINT_AT, SYNC_RUN_ID, 2000);

      // Claim unit as worker 1
      const claimed = await queueRepo.claimWorkUnits(CHECKPOINT_AT, "worker-dying-1", 50, 1);
      expect(claimed.length).toBe(1);

      // Worker 1 dies immediately without processing: simulate lease expiration
      queueRepo.expireAllLeases();

      // Worker 2 arrives and claims the orphaned unit
      const reclaimed = await queueRepo.claimWorkUnits(CHECKPOINT_AT, "worker-recovery-2", 60_000, 1);
      expect(reclaimed.length).toBe(1);
      expect(reclaimed[0].id).toBe(claimed[0].id);
      expect(reclaimed[0].attempts).toBe(2);
    });

    it("Phase 6B: worker kill halfway through a DB batch", async () => {
      const queueRepo = new MockCheckpointWorkQueueRepository();
      const orchestrator = new CheckpointOrchestrator(queueRepo);
      await orchestrator.initializeCheckpoint(CHECKPOINT_AT, SYNC_RUN_ID, 2000);

      const worker1 = new CheckpointWorker(queueRepo, undefined, "worker-1");
      const worker2 = new CheckpointWorker(queueRepo, undefined, "worker-2");

      let processedCount = 0;
      await expect(
        worker1.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async (unit) => {
          processedCount++;
          throw new Error("SIMULATED_WORKER_CRASH");
        })
      ).rejects.toThrow("SIMULATED_WORKER_CRASH");

      expect(processedCount).toBe(1);

      // Lease expires after crash
      queueRepo.expireAllLeases();

      // Worker 2 takes over and successfully finishes all units
      const completedUnits: string[] = [];
      await worker2.runLoop(CHECKPOINT_AT, SYNC_RUN_ID, async (unit) => {
        completedUnits.push(unit.id);
        return { itemsProcessed: 1000 };
      });

      const obs = await queueRepo.getObservabilitySnapshot(CHECKPOINT_AT, SYNC_RUN_ID);
      expect(obs.completedUnits).toBe(2);
      expect(completedUnits).toHaveLength(2);
    });
  });
});
