import { describe, expect, it, vi } from "vitest";
import { SyncService } from "@/services/impl/SyncService";
import { aggregateIncidents } from "@/engine/incident";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";

describe("checkpoint identity contract", () => {
  it("fails before Phase 1 when the durable sync-run identity cannot be read", async () => {
    const syncRuns = {
      getUnfinishedSyncRun: vi.fn().mockRejectedValue(new Error("persistent read unavailable")),
    } as unknown as ISyncRunRepository;
    const result = await new SyncService(syncRuns).runSync();
    expect(result).toMatchObject({ ok: false, syncRunId: "", error: { code: "CHECKPOINT_IDENTITY_UNAVAILABLE" } });
    expect(syncRuns.getUnfinishedSyncRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the composite incident key out of the UUID identity field", () => {
    const incidents = aggregateIncidents([{
      id: "ORD-1", orderCode: "ORD-1", warehouseId: "21152000", warehouseName: "Kho", status: "storing", taskCategory: "Tồn KCT/KTC",
      customerId: "customer-1", customerName: "Customer", customerCode: "C1", fetchedAt: "2026-09-12T01:00:00.000Z", createdAt: "2026-09-10T00:00:00.000Z",
    }], undefined, Date.parse("2026-09-12T01:00:00.000Z"));
    expect(incidents[0]?.incidentKey).toBe("21152000:KHO_TON");
    expect(incidents[0]?.incidentId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
