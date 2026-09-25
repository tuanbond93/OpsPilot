import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncService, ORDERED_SYNC_PHASES } from "@/services/impl/SyncService";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import type { SyncPhase } from "@/connectors/supabase/types";

describe("Sprint 10.4 — Idempotent Sync Recovery & Resume Tests", { timeout: 20000 }, () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Resumes from FETCHING_SNAPSHOT if sync was interrupted at snapshot phase", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    await syncRunRepo.updatePhase(seedRun.id, "CREATED", ["CREATED"]);

    const consoleSpy = vi.spyOn(console, "log");
    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(seedRun.id);

    const logMessages = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logMessages.some((m) => m.includes("[SyncResume]"))).toBe(true);
    expect(logMessages.some((m) => m.includes("[SyncRecovery] previousRunRecovered=true"))).toBe(true);
  });

  it("2. Resume after PERSISTING_INCIDENTS skips completed phases", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    await incidentRepo.upsertIncidents([{
      incidentId: 'inc-test-1',
      incidentKey: '21160000:KHO_TON',
      warehouseId: '21160000',
      warehouseName: 'Kho Phú Thọ',
      reasonCode: 'KHO_TON',
      reasonName: 'Kho tồn',
      status: 'open',
      priorityScore: 80,
      firstDetectedAt: '2026-08-05T08:00:00Z',
      lastDetectedAt: '2026-08-05T08:00:00Z',
      affectedOrderCount: 10,
      sampleOrderCodes: [],
      averageAgeHours: 24,
      maximumAgeHours: 48,
      oldestOrderCode: 'ORD-100',
    }], seedRun.id);

    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS"];
    await syncRunRepo.updatePhase(seedRun.id, "PERSISTING_INCIDENTS", completedBefore);

    const consoleSpy = vi.spyOn(console, "log");
    const service = new SyncService(syncRunRepo, null, incidentRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(seedRun.id);

    const logMessages = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logMessages.some((m) => m.includes("[SyncPhase] phase=PERSISTING_INCIDENTS status=skipped"))).toBe(true);
  });

  it("3. Resume after PERSISTING_HISTORY", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY"];
    await syncRunRepo.updatePhase(seedRun.id, "PERSISTING_HISTORY", completedBefore);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(seedRun.id);
  });

  it("4. Resume after PROCESSING_FOLLOWUPS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS"];
    await syncRunRepo.updatePhase(seedRun.id, "PROCESSING_FOLLOWUPS", completedBefore);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("5. Resume after ENQUEUE_NOTIFICATIONS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS"];
    await syncRunRepo.updatePhase(seedRun.id, "ENQUEUE_NOTIFICATIONS", completedBefore);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("6. Resume after ENQUEUE_AI", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS", "ENQUEUE_AI"];
    await syncRunRepo.updatePhase(seedRun.id, "ENQUEUE_AI", completedBefore);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("7. Resume after REFRESHING_PROJECTIONS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS", "ENQUEUE_AI", "REFRESHING_PROJECTIONS"];
    await syncRunRepo.updatePhase(seedRun.id, "REFRESHING_PROJECTIONS", completedBefore);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("8. Completed sync never resumes, creates a fresh sync_run", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    await syncRunRepo.updateSuccess(seedRun.id, {
      completedAt: new Date().toISOString(),
      fetchedOrderCount: 10,
      normalizedOrderCount: 10,
      incidentCount: 2,
      durationMs: 500,
    });

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).not.toBe(seedRun.id);
  });

  it("9. Failed sync resumes correctly from first incomplete phase", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    await syncRunRepo.updateFailed(seedRun.id, {
      completedAt: new Date().toISOString(),
      durationMs: 200,
      errorCode: "TestError",
      errorMessage: "Simulated crash",
    });
    await syncRunRepo.updatePhase(seedRun.id, "PERSISTING_SNAPSHOTS", ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS"]);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository());
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(seedRun.id);
  });

  it("10. State machine validates ordered phases without illegal skips", () => {
    expect(ORDERED_SYNC_PHASES).toEqual([
      "CREATED",
      "FETCHING_SNAPSHOT",
      "PERSISTING_SNAPSHOTS",
      "PERSISTING_INCIDENTS",
      "PERSISTING_HISTORY",
      "PROCESSING_FOLLOWUPS",
      "ENQUEUE_NOTIFICATIONS",
      "ENQUEUE_AI",
      "REFRESHING_PROJECTIONS",
      "COMPLETED",
    ]);
  });

  const checkpointAt = "2026-09-25T07:00:00.000Z";
  const completedBeforeFinalization = ORDERED_SYNC_PHASES.slice(0, -1);

  async function seedCheckpointRun(
    syncRunRepo: MockSyncRunRepository,
    incidentRepo: MockIncidentRepository,
    requestedCheckpoint: string,
    status: "running" | "failed" = "running",
  ) {
    const run = await syncRunRepo.createSyncRun("2026-09-25T06:00:00.000Z", { checkpointAt: requestedCheckpoint });
    if (status === "failed") {
      await syncRunRepo.updateFailed(run.id, {
        completedAt: "2026-09-25T06:01:00.000Z",
        durationMs: 60_000,
        errorCode: "TEST_INTERRUPTION",
        errorMessage: "test fixture",
      });
    }
    await syncRunRepo.updatePhase(run.id, "REFRESHING_PROJECTIONS", completedBeforeFinalization);
    incidentRepo.seed([{
      id: crypto.randomUUID(),
      incident_key: `warehouse-${run.id}:KHO_TON`,
      warehouse_id: "21160000",
      warehouse_name: "Kho Phú Thọ",
      reason_code: "KHO_TON",
      reason_name: "Kho tồn",
      status: "open",
      priority_score: 80,
      first_detected_at: "2026-09-25T06:00:00.000Z",
      last_detected_at: "2026-09-25T06:00:00.000Z",
      last_sync_run_id: run.id,
      resolved_at: null,
    } as any]);
    return run;
  }

  function completePopulationRepository() {
    return {
      getPopulationManifest: vi.fn().mockResolvedValue({
        population_status: "COMPLETE",
        expected_observation_count: 0,
        persisted_observation_count: 0,
        normalized_population_count: 0,
        duplicate_conflict_count: 0,
        source_freshness: "2026-09-25T07:00:00.000Z",
      }),
      countPersisted: vi.fn().mockResolvedValue(0),
    } as any;
  }

  function mockEmptyRillnetSnapshot() {
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot",
      updatedAt: "2026-09-25T07:00:00.000Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      fetchedAt: "2026-09-25T07:00:00.000Z",
      totalOrders: 0,
      orders: [],
    });
  }

  it("checkpoint selector resumes the exact running checkpoint and never creates a replacement", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const exact = await seedCheckpointRun(syncRunRepo, incidentRepo, checkpointAt, "running");
    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, null, null, null, null, completePopulationRepository());

    const result = await service.runSync({ checkpointAt });

    expect(result.syncRunId).toBe(exact.id);
    expect(await syncRunRepo.getLatestSyncRuns(10)).toHaveLength(1);
  });

  it("checkpoint selector resumes an exact failed run under existing failed-run resume semantics", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const exact = await seedCheckpointRun(syncRunRepo, incidentRepo, checkpointAt, "failed");
    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, null, null, null, null, completePopulationRepository());

    const result = await service.runSync({ checkpointAt });

    expect(result.syncRunId).toBe(exact.id);
    expect((await syncRunRepo.getSyncRunForCheckpoint(checkpointAt))?.status).toBe("success");
  });

  it("skips an exact checkpoint completed while this invocation waited for the lease", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const completed = await syncRunRepo.createSyncRun("2026-09-25T06:00:00.000Z", { checkpointAt });
    await syncRunRepo.updateSuccess(completed.id, {
      completedAt: "2026-09-25T06:01:00.000Z",
      fetchedOrderCount: 0,
      normalizedOrderCount: 0,
      incidentCount: 0,
      durationMs: 60_000,
    });
    const getExactRun = syncRunRepo.getSyncRunForCheckpoint.bind(syncRunRepo);
    vi.spyOn(syncRunRepo, "getSyncRunForCheckpoint")
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(getExactRun);

    const result = await new SyncService(syncRunRepo).runSync({ checkpointAt });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.syncRunId).toBe(completed.id);
    expect(await syncRunRepo.getLatestSyncRuns(10)).toHaveLength(1);
  });

  it("creates a new requested checkpoint run instead of selecting a different historical running run", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const historical = await syncRunRepo.createSyncRun("2026-08-05T12:00:00.000Z", { checkpointAt: "2026-08-05T01:00:00.000Z" });
    await syncRunRepo.updatePhase(historical.id, "CREATED", ["CREATED"]);
    mockEmptyRillnetSnapshot();
    const originalUpdatePhase = syncRunRepo.updatePhase.bind(syncRunRepo);
    vi.spyOn(syncRunRepo, "updatePhase").mockImplementation(async (id, phase, phases) => {
      if (phase === "FETCHING_SNAPSHOT") throw new Error("TEST_STOP_AFTER_SELECTOR");
      return originalUpdatePhase(id, phase, phases);
    });

    const result = await new SyncService(syncRunRepo).runSync({ checkpointAt });

    expect(result.syncRunId).not.toBe(historical.id);
    expect((await syncRunRepo.getSyncRunForCheckpoint(checkpointAt))?.id).toBe(result.syncRunId);
    expect((await syncRunRepo.getSyncRunForCheckpoint("2026-08-05T01:00:00.000Z"))?.status).toBe("running");
  });

  it("creates a new requested checkpoint run instead of selecting a different historical failed run", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const historical = await syncRunRepo.createSyncRun("2026-08-05T12:00:00.000Z", { checkpointAt: "2026-08-05T01:00:00.000Z" });
    await syncRunRepo.updateFailed(historical.id, {
      completedAt: "2026-08-05T12:01:00.000Z", durationMs: 60_000, errorCode: "OLD_FAILURE", errorMessage: "fixture",
    });
    mockEmptyRillnetSnapshot();
    const originalUpdatePhase = syncRunRepo.updatePhase.bind(syncRunRepo);
    vi.spyOn(syncRunRepo, "updatePhase").mockImplementation(async (id, phase, phases) => {
      if (phase === "FETCHING_SNAPSHOT") throw new Error("TEST_STOP_AFTER_SELECTOR");
      return originalUpdatePhase(id, phase, phases);
    });

    const result = await new SyncService(syncRunRepo).runSync({ checkpointAt });

    expect(result.syncRunId).not.toBe(historical.id);
    expect((await syncRunRepo.getSyncRunForCheckpoint(checkpointAt))?.id).toBe(result.syncRunId);
    expect((await syncRunRepo.getSyncRunForCheckpoint("2026-08-05T01:00:00.000Z"))?.status).toBe("failed");
  });

  it("ignores multiple historical running/failed rows when no exact checkpoint exists", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const running = await syncRunRepo.createSyncRun("2026-08-05T12:00:00.000Z", { checkpointAt: "2026-08-05T01:00:00.000Z" });
    const failed = await syncRunRepo.createSyncRun("2026-08-06T12:00:00.000Z", { checkpointAt: "2026-08-06T01:00:00.000Z" });
    await syncRunRepo.updatePhase(running.id, "CREATED", ["CREATED"]);
    await syncRunRepo.updateFailed(failed.id, {
      completedAt: "2026-08-06T12:01:00.000Z", durationMs: 60_000, errorCode: "OLD_FAILURE", errorMessage: "fixture",
    });
    mockEmptyRillnetSnapshot();
    const originalUpdatePhase = syncRunRepo.updatePhase.bind(syncRunRepo);
    vi.spyOn(syncRunRepo, "updatePhase").mockImplementation(async (id, phase, phases) => {
      if (phase === "FETCHING_SNAPSHOT") throw new Error("TEST_STOP_AFTER_SELECTOR");
      return originalUpdatePhase(id, phase, phases);
    });

    const result = await new SyncService(syncRunRepo).runSync({ checkpointAt });

    expect(result.syncRunId).not.toBe(running.id);
    expect(result.syncRunId).not.toBe(failed.id);
    expect((await syncRunRepo.getSyncRunForCheckpoint(checkpointAt))?.id).toBe(result.syncRunId);
  });
});
