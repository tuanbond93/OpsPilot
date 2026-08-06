import type { OrderSnapshotRow } from "@/connectors/supabase/types";

export type { OrderSnapshotRow };

export interface IOrderSnapshotRepository {
  insertBatch(snapshots: OrderSnapshotRow[], batchSize?: number): Promise<number>;
}
