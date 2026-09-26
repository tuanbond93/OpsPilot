import { describe, it, expect, vi } from "vitest";
import { CheckpointRehydrator } from "@/services/checkpoint-rehydrator";
import { MockOrderSnapshotRepository } from "@/repositories/mock/MockOrderSnapshotRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";

describe("Checkpoint Pipeline V2 - Persisted Order Rehydration", () => {
  it("reconstructs NormalizedRillnetOrder[] exclusively from persisted snapshot rows for the exact sync_run_id", async () => {
    const snapshotRepo = new MockOrderSnapshotRepository();
    const syncRunRepo = new MockSyncRunRepository();

    const checkpointAt = "2026-09-26T07:00:00.000Z";
    const syncRunId = "6c6b3a71-8df7-4042-8e30-659767b723e7";

    // Setup sync run
    await syncRunRepo.createSyncRun("2026-09-26T07:00:03.283Z", {
      id: syncRunId,
      checkpointAt,
    });

    // Populate mock snapshots for run 6c6b3a71
    const snapshotRows: OrderSnapshotRow[] = [
      {
        sync_run_id: syncRunId,
        order_code: "ORD_1001",
        warehouse_id: "WH_HNI_01",
        warehouse_name: "Kho Hub Hà Nội",
        source_status: "delivering",
        task_category: "giao_hang",
        source_updated_at: "2026-09-26T06:58:30.000Z",
        order_created_at: "2026-09-25T10:00:00.000Z",
        end_pick_at: "2026-09-26T05:00:00.000Z",
        warehouse_log: [{ current_warehouse_id: "WH_HNI_01", updated_date: "2026-09-26T05:30:00.000Z" }],
      },
      {
        sync_run_id: syncRunId,
        order_code: "ORD_1002",
        warehouse_id: "WH_SGN_01",
        warehouse_name: "Kho Hub Sài Gòn",
        source_status: "delay",
        task_category: "chuyen_tiep",
        source_updated_at: "2026-09-26T06:58:30.000Z",
        order_created_at: "2026-09-24T08:00:00.000Z",
        end_pick_at: "2026-09-24T12:00:00.000Z",
        warehouse_log: [],
      },
    ];
    await snapshotRepo.insertBatch(snapshotRows);

    // Another unrelated run for different checkpoint
    const otherRunId = "unrelated-run-9999";
    await snapshotRepo.insertBatch([
      {
        sync_run_id: otherRunId,
        order_code: "ORD_9999",
        warehouse_id: "WH_OTHER",
        source_status: "returned",
        source_updated_at: "2026-09-26T08:00:00.000Z",
      },
    ]);

    const rehydrator = new CheckpointRehydrator(snapshotRepo, syncRunRepo);
    const result = await rehydrator.rehydrateOrdersForCheckpoint(syncRunId, checkpointAt);

    expect(result.orderCount).toBe(2);
    expect(result.orders.map((o) => o.orderCode)).toEqual(["ORD_1001", "ORD_1002"]);
    expect(result.orders.find((o) => o.orderCode === "ORD_9999")).toBeUndefined();

    // Invariant: fetchedAt matches the snapshot's source_updated_at, NOT wall-clock
    expect(result.orders[0].fetchedAt).toBe("2026-09-26T06:58:30.000Z");
    expect(result.orders[0].warehouseLog).toHaveLength(1);

    // Invariant validation helper passes
    expect(() => {
      CheckpointRehydrator.assertRehydrationInvariant(result, 2, checkpointAt);
    }).not.toThrow();
  });

  it("fails closed when sync run ID does not match the checkpoint_at owner", async () => {
    const snapshotRepo = new MockOrderSnapshotRepository();
    const syncRunRepo = new MockSyncRunRepository();

    const checkpoint14h = "2026-09-26T07:00:00.000Z";
    const checkpoint18h = "2026-09-26T11:00:00.000Z";
    const run14hId = "run-14h-uuid";

    await syncRunRepo.createSyncRun("2026-09-26T07:00:00Z", {
      id: run14hId,
      checkpointAt: checkpoint14h,
    });

    const rehydrator = new CheckpointRehydrator(snapshotRepo, syncRunRepo);

    // Attempting to rehydrate run14h under checkpoint 18h must be rejected
    await expect(
      rehydrator.rehydrateOrdersForCheckpoint(run14hId, checkpoint18h)
    ).rejects.toThrow("CHECKPOINT_REHYDRATION_RUN_MISMATCH");
  });
});
