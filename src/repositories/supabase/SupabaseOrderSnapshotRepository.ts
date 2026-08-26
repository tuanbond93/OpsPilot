import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import type { IOrderSnapshotRepository } from "../interfaces/IOrderSnapshotRepository";

export class SupabaseOrderSnapshotRepository implements IOrderSnapshotRepository {
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

  async getJourneyEvidenceForIncident(
    syncRunId: string,
    warehouseId: string,
    reasonCode: string
  ): Promise<OrderSnapshotRow[]> {
    const { data, error } = await this.client
      .from("order_snapshots")
      .select("order_code,order_created_at,end_pick_at,pick_warehouse_id,deliver_warehouse_id,warehouse_log")
      .eq("sync_run_id", syncRunId)
      .eq("warehouse_id", warehouseId)
      .eq("reason_code", reasonCode);

    if (error) throw new Error(`OrderSnapshotRepository.getJourneyEvidenceForIncident failed: ${error.message}`);
    return (data || []) as OrderSnapshotRow[];
  }
}
