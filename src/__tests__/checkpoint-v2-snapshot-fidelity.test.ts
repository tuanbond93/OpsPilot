import { describe, expect, it } from "vitest";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import { MockOrderSnapshotRepository } from "@/repositories/mock/MockOrderSnapshotRepository";
import { CheckpointRehydrator } from "@/services/checkpoint-rehydrator";

describe("Checkpoint Pipeline V2 snapshot fidelity", () => {
  it("round-trips business-significant normalized order fields through durable checkpoint storage", async () => {
    const checkpointAt = "2026-10-01T07:00:00.000Z";
    const syncRunId = "184d5ad0-58c1-4a14-9d9f-15d5ba1af434";
    const original: NormalizedRillnetOrder = {
      id: "ORD_FIDELITY_001",
      orderCode: "ORD_FIDELITY_001",
      status: "delivering",
      taskCategory: "giao_hang",
      warehouseId: "WH_FIDELITY",
      warehouseName: "Kho fidelity",
      customerId: "CUSTOMER_FIDELITY_001",
      customerName: "Customer fidelity",
      customerCode: "CF001",
      createdAt: "2026-09-30T08:00:00.000Z",
      pickWarehouseId: "WH_PICK",
      deliverWarehouseId: "WH_DELIVER",
      deliverWarehouseName: "Kho giao",
      destinationProvinceId: "79",
      destinationDistrictId: "760",
      weightGrams: 1250,
      weightKg: 1.25,
      sortCode: "SORT_FIDELITY",
      isB2b: true,
      serviceTypeId: "SERVICE_FIDELITY",
      endPickAt: "2026-10-01T02:00:00.000Z",
      endDeliveryAt: null,
      endSuccessAt: null,
      warehouseLog: [{ current_warehouse_id: "WH_FIDELITY", updated_date: "2026-10-01T03:00:00.000Z" }],
      fetchedAt: "2026-10-01T06:55:00.000Z",
    };
    const persisted: OrderSnapshotRow = {
      sync_run_id: syncRunId,
      order_code: original.orderCode,
      warehouse_id: original.warehouseId,
      warehouse_name: original.warehouseName,
      customer_id: original.customerId,
      source_status: original.status,
      task_category: original.taskCategory,
      order_created_at: original.createdAt,
      source_updated_at: original.fetchedAt,
      pick_warehouse_id: original.pickWarehouseId,
      deliver_warehouse_id: original.deliverWarehouseId,
      deliver_warehouse_name: original.deliverWarehouseName,
      destination_province_id: original.destinationProvinceId,
      destination_district_id: original.destinationDistrictId,
      weight_grams: original.weightGrams,
      weight_kg: original.weightKg,
      sort_code: original.sortCode,
      is_b2b: original.isB2b,
      service_type_id: original.serviceTypeId,
      end_pick_at: original.endPickAt,
      end_delivery_at: original.endDeliveryAt,
      end_success_at: original.endSuccessAt,
      warehouse_log: original.warehouseLog,
    };
    const snapshots = new MockOrderSnapshotRepository();
    await snapshots.insertBatch([persisted]);

    // The original object is deliberately discarded before the independent V2 read.
    const rehydrated = await new CheckpointRehydrator(snapshots)
      .rehydrateOrdersForCheckpoint(syncRunId, checkpointAt);
    const actual = rehydrated.orders[0];

    expect(actual).toMatchObject({
      orderCode: original.orderCode,
      status: original.status,
      warehouseId: original.warehouseId,
      customerId: original.customerId,
      deliverWarehouseId: original.deliverWarehouseId,
      endPickAt: original.endPickAt,
      fetchedAt: original.fetchedAt,
    });
    expect(actual.warehouseLog).toEqual(original.warehouseLog);
  });
});
