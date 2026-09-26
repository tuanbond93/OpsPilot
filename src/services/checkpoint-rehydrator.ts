/**
 * Checkpoint Pipeline V2 - Persisted Data Rehydrator
 *
 * Eliminates the in-memory continuation dependency across serverless invocations.
 * Reconstructs NormalizedRillnetOrder[] exclusively from durable data persisted for
 * the exact (sync_run_id, checkpoint_at) tuple.
 *
 * Invariant: rehydrate(T) == data persisted for T
 * NEVER fetches live Rillnet data for historical checkpoints.
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { IOrderSnapshotRepository, OrderSnapshotRow } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";

export interface CheckpointRehydrationResult {
  syncRunId: string;
  checkpointAt: string;
  sourceFreshness: string;
  orderCount: number;
  orders: NormalizedRillnetOrder[];
  rehydratedAt: string;
}

export function mapSnapshotRowToNormalizedOrder(
  row: OrderSnapshotRow,
  fallbackFetchedAt: string
): NormalizedRillnetOrder {
  return {
    id: row.order_code,
    orderCode: row.order_code,
    status: row.source_status || "unknown",
    taskCategory: row.task_category || "",
    warehouseId: row.warehouse_id || "",
    warehouseName: row.warehouse_name || "",
    customerId: "REHYDRATED_CUSTOMER",
    customerName: "",
    customerCode: "",
    createdAt: row.order_created_at || null,
    pickWarehouseId: row.pick_warehouse_id || null,
    deliverWarehouseId: row.deliver_warehouse_id || null,
    deliverWarehouseName: row.deliver_warehouse_name || null,
    destinationProvinceId: row.destination_province_id || null,
    destinationDistrictId: row.destination_district_id || null,
    weightGrams: row.weight_grams ?? null,
    weightKg: row.weight_kg ?? null,
    sortCode: row.sort_code || null,
    isB2b: row.is_b2b ?? null,
    serviceTypeId: row.service_type_id || null,
    endPickAt: row.end_pick_at || null,
    endDeliveryAt: row.end_delivery_at || null,
    endSuccessAt: row.end_success_at || null,
    warehouseLog: Array.isArray(row.warehouse_log) ? (row.warehouse_log as unknown[]) : [],
    fetchedAt: row.source_updated_at || fallbackFetchedAt,
  };
}

export class CheckpointRehydrator {
  constructor(
    private orderSnapshotRepo: IOrderSnapshotRepository,
    private syncRunRepo?: ISyncRunRepository | null
  ) {}

  /**
   * Rehydrates normalized orders from the durable store for a specific checkpoint.
   * Fails closed if the sync run does not match the checkpoint_at identity.
   */
  async rehydrateOrdersForCheckpoint(
    syncRunId: string,
    checkpointAt: string
  ): Promise<CheckpointRehydrationResult> {
    if (!syncRunId || !checkpointAt) {
      throw new Error("CHECKPOINT_REHYDRATION_IDENTITY_MISSING: syncRunId and checkpointAt are required");
    }

    // 1. Checkpoint Identity Verification
    if (this.syncRunRepo) {
      if (this.syncRunRepo.getSyncRunById) {
        const run = await this.syncRunRepo.getSyncRunById(syncRunId);
        if (run?.checkpoint_at && run.checkpoint_at !== checkpointAt) {
          throw new Error(
            `CHECKPOINT_REHYDRATION_RUN_MISMATCH: run ${syncRunId} belongs to checkpoint ${run.checkpoint_at}, cannot rehydrate under ${checkpointAt}`
          );
        }
      }
      const checkpointRun = await this.syncRunRepo.getSyncRunForCheckpoint(checkpointAt);
      if (checkpointRun && checkpointRun.id !== syncRunId) {
        throw new Error(
          `CHECKPOINT_REHYDRATION_RUN_MISMATCH: checkpoint ${checkpointAt} owns run ${checkpointRun.id}, cannot rehydrate for ${syncRunId}`
        );
      }
    }


    // 2. Load persisted order snapshots for this exact syncRunId
    if (!this.orderSnapshotRepo.getSnapshotsForSyncRun) {
      throw new Error("ORDER_SNAPSHOT_REPO_UNSUPPORTED_GET_SNAPSHOTS");
    }

    const snapshotRows = await this.orderSnapshotRepo.getSnapshotsForSyncRun(syncRunId);
    if (!snapshotRows || snapshotRows.length === 0) {
      return {
        syncRunId,
        checkpointAt,
        sourceFreshness: checkpointAt,
        orderCount: 0,
        orders: [],
        rehydratedAt: new Date().toISOString(),
      };
    }

    // 3. Determine the deterministic source freshness timestamp from persisted data
    const sourceFreshness = snapshotRows[0]?.source_updated_at || checkpointAt;

    // 4. Map rows to NormalizedRillnetOrder model with invariant:
    // fetchedAt is strictly the checkpoint's sourceFreshness, never current wall-clock
    const orders: NormalizedRillnetOrder[] = snapshotRows.map((row) =>
      mapSnapshotRowToNormalizedOrder(row, sourceFreshness)
    );

    return {
      syncRunId,
      checkpointAt,
      sourceFreshness,
      orderCount: orders.length,
      orders,
      rehydratedAt: new Date().toISOString(),
    };
  }

  /**
   * Validates rehydration correctness invariants.
   */
  static assertRehydrationInvariant(
    result: CheckpointRehydrationResult,
    expectedCount: number,
    expectedCheckpointAt: string
  ): void {
    if (result.checkpointAt !== expectedCheckpointAt) {
      throw new Error(`INVARIANT_VIOLATION_CHECKPOINT_MISMATCH: expected ${expectedCheckpointAt}, got ${result.checkpointAt}`);
    }
    if (result.orders.length !== expectedCount) {
      throw new Error(`INVARIANT_VIOLATION_ORDER_COUNT_MISMATCH: expected ${expectedCount}, got ${result.orders.length}`);
    }
    for (const order of result.orders) {
      if (!order.orderCode || !order.status) {
        throw new Error(`INVARIANT_VIOLATION_CORRUPTED_ORDER: ${JSON.stringify(order)}`);
      }
      if (order.fetchedAt !== result.sourceFreshness) {
        throw new Error(`INVARIANT_VIOLATION_FRESHNESS_DRIFT: order fetchedAt ${order.fetchedAt} != snapshot ${result.sourceFreshness}`);
      }
    }
  }
}
