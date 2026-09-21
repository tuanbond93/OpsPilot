import type { OrderSnapshotRow } from "@/connectors/supabase/types";

export type { OrderSnapshotRow };

export interface IOrderSnapshotRepository {
  insertBatch(snapshots: OrderSnapshotRow[], batchSize?: number): Promise<number>;
  /** Shadow-only recovery path for a completed sync whose snapshot phase was resumed. */
  getSnapshotsForSyncRun?(syncRunId: string): Promise<OrderSnapshotRow[]>;
  getJourneyEvidenceForIncident?(
    syncRunId: string,
    warehouseId: string,
    reasonCode: string
  ): Promise<OrderSnapshotRow[]>;
}
