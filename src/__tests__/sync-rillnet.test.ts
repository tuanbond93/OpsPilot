import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceFactory } from "@/services/ServiceFactory";
import { syncRillnet } from "@/jobs/sync-rillnet";

describe("Sprint 8.6 — SyncService Architecture & Delegation Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to SyncService via ServiceFactory", async () => {
    const mockSyncSummary: any = {
      ok: true,
      syncRunId: "test-run-1",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      fetchedOrderCount: 0,
      normalizedOrderCount: 0,
      incidentCount: 0,
      phaseTimings: {},
      dbInstrumentation: {
        totalQueries: 0,
        phases: {},
        bottlenecksDetected: [],
      },
    };

    const getSyncServiceSpy = vi.spyOn(ServiceFactory, "getSyncService").mockReturnValue({
      runSync: vi.fn().mockResolvedValue(mockSyncSummary),
    } as any);

    const result = await syncRillnet();

    expect(getSyncServiceSpy).toHaveBeenCalled();
    expect(result).toBe(mockSyncSummary);
  });
});
