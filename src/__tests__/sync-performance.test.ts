import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncService } from "@/services/impl/SyncService";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { RillnetConnector } from "@/connectors/rillnet";

describe("Sync performance safeguards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips download and persistence when the source version is unchanged", async () => {
    const repo = new MockSyncRunRepository();
    repo.seed([
      {
        id: "previous-success",
        started_at: "2026-08-23T01:00:00.000Z",
        completed_at: "2026-08-23T01:01:00.000Z",
        status: "success",
        current_phase: "COMPLETED",
        completed_phases: ["COMPLETED"],
        fetched_order_count: 16269,
        normalized_order_count: 16269,
        incident_count: 383,
        duration_ms: 60000,
        source_updated_at: "2026-08-23T02:00:00.000Z",
        error_code: null,
        error_message: null,
        created_at: "2026-08-23T01:00:00.000Z",
      },
    ]);
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot.gz",
      updatedAt: "2026-08-23T02:00:00.000Z",
    });
    const downloadSpy = vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly");

    const result = await new SyncService(repo).runSync();

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("SOURCE_UNCHANGED");
    expect(result.fetchedOrderCount).toBe(16269);
    expect(result.incidentCount).toBe(383);
    expect(downloadSpy).not.toHaveBeenCalled();
    const latest = await repo.getLatestSyncRun();
    expect(latest?.status).toBe("success");
    expect(latest?.current_phase).toBe("COMPLETED");
  });

  it("reprocesses an unchanged source when a manual evidence backfill is requested", async () => {
    const repo = new MockSyncRunRepository();
    repo.seed([{
      id: "previous-success", started_at: "2026-08-23T01:00:00.000Z", completed_at: "2026-08-23T01:01:00.000Z",
      status: "success", current_phase: "COMPLETED", completed_phases: ["COMPLETED"], fetched_order_count: 1,
      normalized_order_count: 1, incident_count: 1, duration_ms: 1000, source_updated_at: "2026-08-23T02:00:00.000Z",
      error_code: null, error_message: null, created_at: "2026-08-23T01:00:00.000Z",
    }]);
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot.gz", updatedAt: "2026-08-23T02:00:00.000Z",
    });
    const downloadSpy = vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({ orders: [], totalOrders: 0, fetchedAt: "2026-08-23T02:00:00.000Z" });

    const result = await new SyncService(repo).runSync({ forceReprocessSource: true });

    expect(result.skipped).not.toBe(true);
    expect(downloadSpy).toHaveBeenCalledOnce();
  });
});
