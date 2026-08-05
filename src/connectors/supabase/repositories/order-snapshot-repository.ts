import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderSnapshotRow } from "../types";

export class OrderSnapshotRepository {
  constructor(private client: SupabaseClient) {}

  /**
   * Inserts order snapshots in batches (default batch size: 500)
   */
  async insertBatch(
    snapshots: OrderSnapshotRow[],
    batchSize: number = 500
  ): Promise<number> {
    if (snapshots.length === 0) return 0;

    let insertedTotal = 0;

    for (let i = 0; i < snapshots.length; i += batchSize) {
      const batch = snapshots.slice(i, i + batchSize);
      const { error } = await this.client
        .from("order_snapshots")
        .upsert(batch, {
          onConflict: "sync_run_id,order_code,warehouse_id,source_status",
          ignoreDuplicates: true,
        });

      if (error) {
        throw new Error(`OrderSnapshotRepository.insertBatch failed: ${error.message}`);
      }

      insertedTotal += batch.length;
    }

    return insertedTotal;
  }
}
