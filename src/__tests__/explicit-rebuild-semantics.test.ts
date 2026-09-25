import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncService, ORDERED_SYNC_PHASES } from "@/services/impl/SyncService";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockSyncLockRepository } from "@/repositories/mock/MockSyncLockRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import type { SyncRunRow } from "@/connectors/supabase/types";

describe("Explicit Rebuild Semantics Regressions", { timeout: 20000 }, () => {
  let syncRunRepo: MockSyncRunRepository;
  let syncLockRepo: MockSyncLockRepository;
  let incidentRepo: MockIncidentRepository;

  beforeEach(() => {
    vi.restoreAllMocks();
    syncRunRepo = new MockSyncRunRepository();
    syncLockRepo = new MockSyncLockRepository();
    incidentRepo = new MockIncidentRepository();
  });

  it("A. forceReprocessSource=true + historical failed run exists => new run created from FETCHING_SNAPSHOT, getUnfinishedSyncRun NOT called", async () => {
    const historicalFailedRun: SyncRunRow = {
      id: "bb99273b-6400-4811-bd96-b7e0b8e8278e",
      started_at: "2026-09-25T11:00:02.546Z",
      completed_at: "2026-09-25T11:02:00.086Z",
      status: "failed",
      current_phase: "FAILED",
      completed_phases: ["CREATED", "FETCHING_SNAPSHOT"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      created_at: "2026-09-25T11:00:02.546Z",
    };
    syncRunRepo.seed([historicalFailedRun]);

    const getUnfinishedSpy = vi.spyOn(syncRunRepo, "getUnfinishedSyncRun");

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync({ forceReprocessSource: true });

    expect(result.ok).toBe(true);
    // getUnfinishedSyncRun was NOT called
    expect(getUnfinishedSpy).not.toHaveBeenCalled();
    // A new sync run was created (not the historical failed run)
    expect(result.syncRunId).not.toBe(historicalFailedRun.id);
    expect(result.syncRunId).toBeDefined();
    expect(result.syncRunId.length).toBeGreaterThan(0);

    // Verify historical failed run was untouched
    const historicalAfter = (await syncRunRepo.getLatestSyncRuns(10)).find(r => r.id === historicalFailedRun.id);
    expect(historicalAfter).toBeDefined();
    expect(historicalAfter?.status).toBe("failed");
    expect(historicalAfter?.current_phase).toBe("FAILED");
    expect(historicalAfter?.completed_at).toBe(historicalFailedRun.completed_at);
  });

  it("B. forceReprocessSource=true + multiple historical failed runs => none resumed, historical rows untouched, new run created", async () => {
    const failedRun1: SyncRunRow = {
      id: "bb99273b-6400-4811-bd96-b7e0b8e8278e",
      started_at: "2026-09-25T11:00:02.546Z",
      completed_at: "2026-09-25T11:02:00.086Z",
      status: "failed",
      current_phase: "FAILED",
      completed_phases: ["CREATED"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      created_at: "2026-09-25T11:00:02.546Z",
    };
    const failedRun2: SyncRunRow = {
      id: "76976926-de6e-4310-ba59-89f7d923b574",
      started_at: "2026-09-24T11:00:03.260Z",
      completed_at: "2026-09-24T11:01:37.588Z",
      status: "failed",
      current_phase: "FAILED",
      completed_phases: ["CREATED"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      created_at: "2026-09-24T11:00:03.260Z",
    };
    syncRunRepo.seed([failedRun1, failedRun2]);

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync({ forceReprocessSource: true });

    expect(result.ok).toBe(true);
    expect(result.syncRunId).not.toBe(failedRun1.id);
    expect(result.syncRunId).not.toBe(failedRun2.id);

    // Verify both historical failed runs remain untouched
    const runsAfter = await syncRunRepo.getLatestSyncRuns(10);
    const after1 = runsAfter.find(r => r.id === failedRun1.id);
    const after2 = runsAfter.find(r => r.id === failedRun2.id);
    expect(after1?.status).toBe("failed");
    expect(after1?.current_phase).toBe("FAILED");
    expect(after2?.status).toBe("failed");
    expect(after2?.current_phase).toBe("FAILED");
  });

  it("C. normal non-rebuild sync without checkpoint => preserves current legacy behavior", async () => {
    const unfinishedRunId = "a1111111-1111-4111-8111-111111111111";
    const unfinishedRun: SyncRunRow = {
      id: unfinishedRunId,
      started_at: "2026-09-25T12:00:00.000Z",
      completed_at: null,
      status: "running",
      current_phase: "PROCESSING_FOLLOWUPS",
      completed_phases: ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY"],
      fetched_order_count: 10,
      normalized_order_count: 10,
      incident_count: 1,
      created_at: "2026-09-25T12:00:00.000Z",
    };
    syncRunRepo.seed([unfinishedRun]);

    const getUnfinishedSpy = vi.spyOn(syncRunRepo, "getUnfinishedSyncRun");

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync(); // no options

    expect(getUnfinishedSpy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    // Preserves resume: resumed the legacy unfinished run
    expect(result.syncRunId).toBe(unfinishedRun.id);
  });

  it("D. checkpointAt + failed exact checkpoint => exact checkpoint resume behavior unchanged", async () => {
    const checkpointAt = "2026-09-25T01:00:00.000Z";
    const checkpointFailedRunId = "d2222222-2222-4222-8222-222222222222";
    const checkpointFailedRun: SyncRunRow = {
      id: checkpointFailedRunId,
      checkpoint_at: checkpointAt,
      started_at: "2026-09-25T01:00:02.000Z",
      completed_at: "2026-09-25T01:01:00.000Z",
      status: "failed",
      current_phase: "PROCESSING_FOLLOWUPS",
      completed_phases: ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY"],
      fetched_order_count: 5,
      normalized_order_count: 5,
      incident_count: 1,
      created_at: "2026-09-25T01:00:02.000Z",
    };
    syncRunRepo.seed([checkpointFailedRun]);

    const getCheckpointSpy = vi.spyOn(syncRunRepo, "getSyncRunForCheckpoint");

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync({ checkpointAt });

    expect(getCheckpointSpy).toHaveBeenCalledWith(checkpointAt);
    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(checkpointFailedRun.id);
  });

  it("E. checkpointAt + completed exact checkpoint => CHECKPOINT_ALREADY_COMPLETED unchanged", async () => {
    const checkpointAt = "2026-09-25T01:00:00.000Z";
    const checkpointCompletedRunId = "e3333333-3333-4333-8333-333333333333";
    const checkpointCompletedRun: SyncRunRow = {
      id: checkpointCompletedRunId,
      checkpoint_at: checkpointAt,
      started_at: "2026-09-25T01:00:02.000Z",
      completed_at: "2026-09-25T01:02:00.000Z",
      status: "success",
      current_phase: "COMPLETED",
      completed_phases: [...ORDERED_SYNC_PHASES],
      fetched_order_count: 20,
      normalized_order_count: 20,
      incident_count: 0,
      created_at: "2026-09-25T01:00:02.000Z",
    };
    syncRunRepo.seed([checkpointCompletedRun]);

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync({ checkpointAt });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("CHECKPOINT_ALREADY_COMPLETED");
    expect(result.syncRunId).toBe(checkpointCompletedRun.id);
  });

  it("F. rebuild with active global sync lock => SYNC_ALREADY_RUNNING and no new run created", async () => {
    // Acquire the lock first so the next caller cannot acquire it
    await syncLockRepo.acquireLock("global:rillnet-sync", "other-holder", 60000);

    const initialRuns = await syncRunRepo.getLatestSyncRuns(10);
    const initialRunCount = initialRuns.length;

    const service = new SyncService(syncRunRepo, null, incidentRepo, null, null, null, null, null, syncLockRepo);
    const result = await service.runSync({ forceReprocessSource: true });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SYNC_ALREADY_RUNNING");

    // No new run was created in sync_runs
    const runsAfter = await syncRunRepo.getLatestSyncRuns(10);
    expect(runsAfter.length).toBe(initialRunCount);
  });
});
