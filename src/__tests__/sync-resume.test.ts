import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncService, ORDERED_SYNC_PHASES } from "@/services/impl/SyncService";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import type { SyncPhase } from "@/connectors/supabase/types";

describe("Sprint 10.4 — Idempotent Sync Recovery & Resume Tests", { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Resumes from FETCHING_SNAPSHOT if sync was interrupted at snapshot phase", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    await syncRunRepo.updatePhase(seedRun.id, "CREATED", ["CREATED"]);

    const consoleSpy = vi.spyOn(console, "log");
    const service = new SyncService(syncRunRepo);
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

    const service = new SyncService(syncRunRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(seedRun.id);
  });

  it("4. Resume after PROCESSING_FOLLOWUPS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS"];
    await syncRunRepo.updatePhase(seedRun.id, "PROCESSING_FOLLOWUPS", completedBefore);

    const service = new SyncService(syncRunRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("5. Resume after ENQUEUE_NOTIFICATIONS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS"];
    await syncRunRepo.updatePhase(seedRun.id, "ENQUEUE_NOTIFICATIONS", completedBefore);

    const service = new SyncService(syncRunRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("6. Resume after ENQUEUE_AI", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS", "ENQUEUE_AI"];
    await syncRunRepo.updatePhase(seedRun.id, "ENQUEUE_AI", completedBefore);

    const service = new SyncService(syncRunRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(true);
  });

  it("7. Resume after REFRESHING_PROJECTIONS", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const seedRun = await syncRunRepo.createSyncRun();
    const completedBefore: SyncPhase[] = ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY", "PROCESSING_FOLLOWUPS", "ENQUEUE_NOTIFICATIONS", "ENQUEUE_AI", "REFRESHING_PROJECTIONS"];
    await syncRunRepo.updatePhase(seedRun.id, "REFRESHING_PROJECTIONS", completedBefore);

    const service = new SyncService(syncRunRepo);
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

    const service = new SyncService(syncRunRepo);
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

    const service = new SyncService(syncRunRepo);
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
});
