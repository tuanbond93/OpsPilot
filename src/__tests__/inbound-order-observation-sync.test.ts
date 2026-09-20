import { describe, expect, it, vi } from "vitest";
import { RillnetConnector } from "@/connectors/rillnet";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import type { InboundOrderObservationRow } from "@/repositories/interfaces/IInboundOrderObservationRepository";
import { buildCompleteInboundObservationPopulation, SyncService } from "@/services/impl/SyncService";

const BASE_ORDER = {
  status: "transporting",
  warehouseId: "UPSTREAM",
  deliverWarehouseId: "TARGET",
  weightKg: 10,
  isB2b: false,
  fetchedAt: "2026-09-19T03:00:00.000Z",
};

describe("complete inbound observation population", () => {
  it("persists every normalized source order before incident selection", async () => {
    const rows: InboundOrderObservationRow[] = [];
    const manifests: string[] = [];
    const fullPopulationRepo = {
      startPopulation: vi.fn(async () => { manifests.push("STARTED"); }),
      insertBatch: vi.fn(async (input: InboundOrderObservationRow[]) => {
        rows.push(...input);
        return input.length;
      }),
      countPersisted: vi.fn(async () => rows.length),
      completePopulation: vi.fn(async () => { manifests.push("COMPLETE"); }),
      failPopulation: vi.fn(async () => { manifests.push("FAILED"); }),
    };
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot.gz",
      updatedAt: "2026-09-19T03:00:00.000Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      totalOrders: 3,
      fetchedAt: "2026-09-19T03:00:00.000Z",
      orders: [
        { orderCode: "NON_INCIDENT", status: "transporting", warehouseId: "UPSTREAM", warehouseName: "Upstream", deliverWarehouseId: "TARGET", weightKg: 10, isB2b: false, fetchedAt: "2026-09-19T03:00:00.000Z" },
        { orderCode: "NON_INCIDENT_PICKED", status: "picked", warehouseId: "UPSTREAM", warehouseName: "Upstream", deliverWarehouseId: "TARGET", weightKg: 5, isB2b: false, endPickAt: "2026-09-19T02:00:00.000Z", fetchedAt: "2026-09-19T03:00:00.000Z" },
        { orderCode: "INCIDENT_CANDIDATE", status: "storing", warehouseId: "TARGET", warehouseName: "Target", deliverWarehouseId: "TARGET", weightKg: null, isB2b: true, fetchedAt: "2026-09-19T03:00:00.000Z" },
      ],
    } as any);

    const syncRuns = new MockSyncRunRepository();
    const sourceCore: any[] = [];
    const service = new SyncService(
      syncRuns, null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, fullPopulationRepo,
    );
    const result = await service.runSync({
      forceReprocessSource: true,
      checkpointAt: "2026-09-19T04:00:00.000Z",
      onSourceCoreComplete: async (context) => {
        sourceCore.push({ context, status: (await syncRuns.getLatestSyncRun())?.status });
      },
    });

    expect(result.ok).toBe(true);
    expect(fullPopulationRepo.insertBatch).toHaveBeenCalledOnce();
    expect(rows.map((row) => row.order_code)).toEqual(["NON_INCIDENT", "NON_INCIDENT_PICKED", "INCIDENT_CANDIDATE"]);
    expect(rows.every((row) => row.source_system === "RILLNET")).toBe(true);
    expect(manifests).toEqual(["STARTED", "COMPLETE"]);
    expect(sourceCore).toEqual([expect.objectContaining({
      status: "running",
      context: expect.objectContaining({ sourceFreshness: "2026-09-19T03:00:00.000Z" }),
    })]);
    expect(fullPopulationRepo.completePopulation).toHaveBeenCalledWith(expect.objectContaining({
      source_freshness: "2026-09-19T03:00:00.000Z",
    }));
    expect(rows.every((row) => "customer_name" in row === false)).toBe(true);
  });

  it("collapses identical duplicates but blocks conflicting or pseudo-newer duplicates without a trusted per-order timestamp", () => {
    const identical = buildCompleteInboundObservationPopulation("00000000-0000-4000-8000-000000000001", [
      { ...BASE_ORDER, orderCode: "DUPLICATE" },
      { ...BASE_ORDER, orderCode: "DUPLICATE" },
    ] as any, "2026-09-19T03:00:00.000Z");
    expect(identical.rows).toHaveLength(1);
    expect(identical.duplicateIdenticalCount).toBe(1);

    const conflict = buildCompleteInboundObservationPopulation("00000000-0000-4000-8000-000000000001", [
      { ...BASE_ORDER, orderCode: "CONFLICT", weightKg: 10 },
      { ...BASE_ORDER, orderCode: "CONFLICT", weightKg: 11, fetchedAt: "2026-09-19T04:00:00.000Z" },
    ] as any, "2026-09-19T03:00:00.000Z");
    expect(conflict.duplicateConflictCount).toBe(1);
    expect(conflict.duplicateConflictOrderCodes).toEqual(["CONFLICT"]);
  });

  it("marks the population FAILED and prevents sync success when persistence fails", async () => {
    const states: string[] = [];
    const failingRepo = {
      startPopulation: vi.fn(async () => { states.push("STARTED"); }),
      insertBatch: vi.fn(async () => { throw new Error("DATABASE_WRITE_FAILED"); }),
      countPersisted: vi.fn(async () => 0),
      completePopulation: vi.fn(async () => { states.push("COMPLETE"); }),
      failPopulation: vi.fn(async () => { states.push("FAILED"); }),
    };
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({ downloadUrl: "https://example.test/snapshot.gz", updatedAt: "2026-09-19T03:00:00.000Z" });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({ totalOrders: 1, fetchedAt: "2026-09-19T03:00:00.000Z", orders: [{ ...BASE_ORDER, orderCode: "WRITE_FAIL" }] } as any);

    const result = await new SyncService(new MockSyncRunRepository(), null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, failingRepo).runSync({ forceReprocessSource: true });
    expect(result.ok).toBe(false);
    expect(states).toEqual(["STARTED", "FAILED"]);
  });
});
