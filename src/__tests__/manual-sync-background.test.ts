import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncRillnetMock } = vi.hoisted(() => ({ syncRillnetMock: vi.fn() }));

vi.mock("@/jobs/sync-rillnet", () => ({
  syncRillnet: syncRillnetMock,
}));

import { getManualSyncState, startManualSync } from "@/jobs/manual-sync-background";

describe("Manual background sync", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__opspilotManualSyncRegistry;
    syncRillnetMock.mockReset();
  });

  it("returns immediately and rejects a duplicate request while running", async () => {
    let finish!: (value: unknown) => void;
    syncRillnetMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    expect(startManualSync().accepted).toBe(true);
    expect(getManualSyncState().status).toBe("running");
    expect(startManualSync().accepted).toBe(false);

    finish({
      ok: true,
      syncRunId: "run-1",
      startedAt: "2026-08-23T01:00:00.000Z",
      completedAt: "2026-08-23T01:00:01.000Z",
      durationMs: 1000,
      fetchedOrderCount: 10,
      normalizedOrderCount: 10,
      incidentCount: 2,
      phaseTimings: {},
      dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] },
    });
    await vi.waitFor(() => expect(getManualSyncState().status).toBe("success"));
  });
});
