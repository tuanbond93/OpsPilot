import { describe, expect, it, vi } from "vitest";
import { RillnetConnector } from "@/connectors/rillnet";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import type { InboundOrderObservationRow } from "@/repositories/interfaces/IInboundOrderObservationRepository";
import { SyncService } from "@/services/impl/SyncService";

describe("complete inbound observation population", () => {
  it("persists every normalized source order before incident selection", async () => {
    const rows: InboundOrderObservationRow[] = [];
    const fullPopulationRepo = {
      insertBatch: vi.fn(async (input: InboundOrderObservationRow[]) => {
        rows.push(...input);
        return input.length;
      }),
    };
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot.gz",
      updatedAt: "2026-09-19T03:00:00.000Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      totalOrders: 2,
      fetchedAt: "2026-09-19T03:00:00.000Z",
      orders: [
        { orderCode: "NON_INCIDENT", status: "transporting", warehouseId: "UPSTREAM", warehouseName: "Upstream", deliverWarehouseId: "TARGET", weightKg: 10, isB2b: false, fetchedAt: "2026-09-19T03:00:00.000Z" },
        { orderCode: "INCIDENT_CANDIDATE", status: "storing", warehouseId: "TARGET", warehouseName: "Target", deliverWarehouseId: "TARGET", weightKg: null, isB2b: true, fetchedAt: "2026-09-19T03:00:00.000Z" },
      ],
    } as any);

    const service = new SyncService(
      new MockSyncRunRepository(), null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, fullPopulationRepo,
    );
    const result = await service.runSync({ forceReprocessSource: true });

    expect(result.ok).toBe(true);
    expect(fullPopulationRepo.insertBatch).toHaveBeenCalledOnce();
    expect(rows.map((row) => row.order_code)).toEqual(["NON_INCIDENT", "INCIDENT_CANDIDATE"]);
    expect(rows.every((row) => "customer_name" in row === false)).toBe(true);
  });
});
