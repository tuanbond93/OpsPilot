import { describe, expect, it, vi, beforeEach } from "vitest";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import { SyncService } from "@/services/impl/SyncService";

/**
 * REGRESSION SUITE: CHECKPOINT-SCOPED RESUME & IDENTITY INVARIANTS
 *
 * Demonstrates:
 * Scenario A:
 *   08h run unfinished (checkpoint_at = 2026-09-26T01:00:00.000Z).
 *   10h natural checkpoint executes (checkpointAt = 2026-09-26T03:00:00.000Z).
 *   The 10h checkpoint MUST NOT accidentally inherit the 08h run solely because it is unfinished.
 *   Generic un-checkpointed sync also MUST NOT adopt the 08h run.
 *
 * Scenario B:
 *   Explicit recovery of the 08h checkpoint.
 *   The 08h run may be resumed only through a path that explicitly carries
 *   the matching checkpoint identity.
 *
 * Scenario C:
 *   Multiple zombie running rows exist with no active lock.
 *   They must not cause arbitrary run selection or contaminate checkpoint runs.
 */
describe("Checkpoint-Scoped Resume & Identity Invariants", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot",
      updatedAt: "2026-09-26T03:00:00.000Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      fetchedAt: "2026-09-26T03:00:00.000Z",
      totalOrders: 0,
      orders: [],
    });
  });

  function observationRepository() {
    return {
      getPopulationManifest: vi.fn().mockResolvedValue(null),
      countPersisted: vi.fn().mockResolvedValue(0),
      replaceIncompletePopulation: vi.fn().mockResolvedValue(undefined),
      insertBatch: vi.fn().mockResolvedValue(0),
      completePopulation: vi.fn().mockResolvedValue(undefined),
      failPopulation: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  describe("Scenario A: 08h run unfinished when 10h natural checkpoint executes", () => {
    it("10h natural checkpoint creates a new run and does not inherit unfinished 08h run", async () => {
      const syncRunRepo = new MockSyncRunRepository();
      const incidentRepo = new MockIncidentRepository();

      // Seed 08h unfinished run
      const run08h = await syncRunRepo.createSyncRun("2026-09-26T01:00:03.243Z", {
        checkpointAt: "2026-09-26T01:00:00.000Z",
      });
      await syncRunRepo.updatePhase(run08h.id, "PERSISTING_HISTORY", [
        "CREATED",
        "FETCHING_SNAPSHOT",
        "PERSISTING_SNAPSHOTS",
        "PERSISTING_INCIDENTS",
        "PERSISTING_HISTORY",
      ]);

      const service = new SyncService(
        syncRunRepo,
        null,
        incidentRepo,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        observationRepository()
      );

      // Execute 10h natural checkpoint
      const result10h = await service.runSync({
        checkpointAt: "2026-09-26T03:00:00.000Z",
      });

      expect(result10h.ok).toBe(true);
      expect(result10h.syncRunId).not.toBe(run08h.id);

      // Verify the 10h run was created with its own checkpoint identity
      const run10h = await syncRunRepo.getSyncRunForCheckpoint("2026-09-26T03:00:00.000Z");
      expect(run10h).not.toBeNull();
      expect(run10h?.id).toBe(result10h.syncRunId);
      expect(run10h?.checkpoint_at).toBe("2026-09-26T03:00:00.000Z");

      // Verify 08h run remains untouched in its original checkpoint state
      const run08hAfter = await syncRunRepo.getSyncRunForCheckpoint("2026-09-26T01:00:00.000Z");
      expect(run08hAfter?.id).toBe(run08h.id);
      expect(run08hAfter?.checkpoint_at).toBe("2026-09-26T01:00:00.000Z");
    });

    it("generic un-checkpointed sync does NOT adopt unfinished 08h checkpoint run", async () => {
      const syncRunRepo = new MockSyncRunRepository();
      const incidentRepo = new MockIncidentRepository();

      // Seed 08h unfinished run
      const run08h = await syncRunRepo.createSyncRun("2026-09-26T01:00:03.243Z", {
        checkpointAt: "2026-09-26T01:00:00.000Z",
      });
      await syncRunRepo.updatePhase(run08h.id, "PERSISTING_HISTORY", [
        "CREATED",
        "FETCHING_SNAPSHOT",
        "PERSISTING_SNAPSHOTS",
        "PERSISTING_INCIDENTS",
        "PERSISTING_HISTORY",
      ]);

      const service = new SyncService(
        syncRunRepo,
        null,
        incidentRepo,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        observationRepository()
      );

      // Run generic sync (no checkpointAt)
      const genericResult = await service.runSync();

      expect(genericResult.ok).toBe(true);
      expect(genericResult.syncRunId).not.toBe(run08h.id);

      // Checkpoint run is not adopted or marked completed by the generic sync
      const run08hAfter = await syncRunRepo.getSyncRunForCheckpoint("2026-09-26T01:00:00.000Z");
      expect(run08hAfter?.id).toBe(run08h.id);
      expect(run08hAfter?.checkpoint_at).toBe("2026-09-26T01:00:00.000Z");
    });
  });

  describe("Scenario B: Explicit recovery of 08h checkpoint", () => {
    it("resumes ONLY when explicit matching checkpointAt is provided", async () => {
      const syncRunRepo = new MockSyncRunRepository();
      const incidentRepo = new MockIncidentRepository();

      // Seed 08h unfinished run
      const run08h = await syncRunRepo.createSyncRun("2026-09-26T01:00:03.243Z", {
        checkpointAt: "2026-09-26T01:00:00.000Z",
      });
      await syncRunRepo.updatePhase(run08h.id, "PERSISTING_HISTORY", [
        "CREATED",
        "FETCHING_SNAPSHOT",
        "PERSISTING_SNAPSHOTS",
        "PERSISTING_INCIDENTS",
        "PERSISTING_HISTORY",
      ]);

      const service = new SyncService(
        syncRunRepo,
        null,
        incidentRepo,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        observationRepository()
      );

      // Explicit recovery with the EXACT matching checkpointAt
      const recoveryResult = await service.runSync({
        checkpointAt: "2026-09-26T01:00:00.000Z",
      });

      expect(recoveryResult.ok).toBe(true);
      expect(recoveryResult.syncRunId).toBe(run08h.id);

      const runAfterRecovery = await syncRunRepo.getSyncRunForCheckpoint("2026-09-26T01:00:00.000Z");
      expect(runAfterRecovery?.id).toBe(run08h.id);
      expect(runAfterRecovery?.status).toBe("success");
      expect(runAfterRecovery?.current_phase).toBe("COMPLETED");
    });

    it("does NOT resume 08h run if recovery checkpointAt is different", async () => {
      const syncRunRepo = new MockSyncRunRepository();
      const incidentRepo = new MockIncidentRepository();

      const run08h = await syncRunRepo.createSyncRun("2026-09-26T01:00:03.243Z", {
        checkpointAt: "2026-09-26T01:00:00.000Z",
      });

      const service = new SyncService(
        syncRunRepo,
        null,
        incidentRepo,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        observationRepository()
      );

      // Attempt recovery for 14h checkpoint
      const result14h = await service.runSync({
        checkpointAt: "2026-09-26T07:00:00.000Z",
      });

      expect(result14h.ok).toBe(true);
      expect(result14h.syncRunId).not.toBe(run08h.id);
    });
  });

  describe("Scenario C: Multiple historical zombie running rows exist", () => {
    it("does not allow 7 zombie running rows to cause arbitrary selection in checkpoint sync", async () => {
      const syncRunRepo = new MockSyncRunRepository();
      const incidentRepo = new MockIncidentRepository();

      // Seed 7 historical zombie running rows (abandoned without active lock)
      const zombieIds: string[] = [];
      for (let i = 1; i <= 7; i++) {
        const run = await syncRunRepo.createSyncRun(`2026-09-25T${String(i).padStart(2, "0")}:00:00.000Z`, {
          checkpointAt: i <= 3 ? `2026-09-25T0${i}:00:00.000Z` : undefined,
        });
        await syncRunRepo.updatePhase(run.id, "CREATED", ["CREATED"]);
        zombieIds.push(run.id);
      }

      // Verify 7 zombie rows are currently in 'running' state
      const unfinishedRuns = await syncRunRepo.getUnfinishedSyncRuns(20);
      expect(unfinishedRuns.length).toBe(7);

      const service = new SyncService(
        syncRunRepo,
        null,
        incidentRepo,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        observationRepository()
      );

      // 1. Natural checkpoint run for 10h must NOT pick any of the 7 zombies
      const checkpoint10hResult = await service.runSync({
        checkpointAt: "2026-09-26T03:00:00.000Z",
      });
      expect(zombieIds.includes(checkpoint10hResult.syncRunId)).toBe(false);

      // 2. Un-checkpointed sync must only consider runs with checkpoint_at IS NULL
      // The newest zombie with checkpoint_at === undefined was seeded at 07:00:00 (i=7)
      const uncheckpointedResult = await service.runSync();
      // It should resume the newest non-checkpoint zombie run, not any checkpoint run
      const resumedRun = (await syncRunRepo.getLatestSyncRuns(10)).find((r) => r.id === uncheckpointedResult.syncRunId);
      expect(resumedRun?.checkpoint_at ?? null).toBeNull();
      // It must never adopt zombie 1, 2, or 3 (which had checkpoint_at defined)
      expect([zombieIds[0], zombieIds[1], zombieIds[2]].includes(uncheckpointedResult.syncRunId)).toBe(false);
    });
  });
});
