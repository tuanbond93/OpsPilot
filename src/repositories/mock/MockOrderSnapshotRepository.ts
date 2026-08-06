import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import type { IOrderSnapshotRepository } from "../interfaces/IOrderSnapshotRepository";

export class MockOrderSnapshotRepository implements IOrderSnapshotRepository {
  private snapshots: OrderSnapshotRow[] = [];

  async insertBatch(
    snapshots: OrderSnapshotRow[],
    _batchSize: number = 500
  ): Promise<number> {
    this.snapshots.push(...snapshots);
    return snapshots.length;
  }

  getSnapshots(): OrderSnapshotRow[] {
    return [...this.snapshots];
  }

  clear(): void {
    this.snapshots = [];
  }
}
