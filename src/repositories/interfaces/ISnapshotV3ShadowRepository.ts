import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import type { SnapshotV3Comparison } from "@/domain/snapshot-v3/comparator";

export type SnapshotV3ShadowWriteResult = {
  stateVersionRows: number;
  referenceRows: number;
  reusedStateVersions: number;
};

export type SnapshotV3StorageTelemetry = {
  stateVersionRows: number;
  stateVersionAvgBytes: number | null;
  referenceRows: number;
  referenceAvgBytes: number | null;
  stateVersionBytesTotal: number;
  referenceBytesTotal: number;
  legacyEquivalentBytes: number | null;
  actualStorageReductionPct: number | null;
};

export interface ISnapshotV3ShadowRepository {
  writeBatch(
    syncRunId: string,
    rows: OrderSnapshotRow[],
    evaluationReferenceAt: string,
    batchSize?: number
  ): Promise<SnapshotV3ShadowWriteResult>;
  reconstructSyncRun(syncRunId: string): Promise<OrderSnapshotRow[]>;
  recordComparison?(syncRunId: string, comparison: SnapshotV3Comparison): Promise<void>;
  getStorageTelemetry?(): Promise<SnapshotV3StorageTelemetry>;
}
