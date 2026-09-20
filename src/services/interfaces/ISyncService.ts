import type { SyncJobResult } from "@/jobs/sync-rillnet";

export type SyncSummary = SyncJobResult;

export interface SyncOptions {
  referenceTimeMs?: number;
  forceReprocessSource?: boolean;
  /** Present only for a governed natural checkpoint or its single recovery. */
  checkpointAt?: string;
  /** Invoked after the exact run's source population is COMPLETE and reconciled. */
  onSourceCoreComplete?: (context: {
    syncRunId: string;
    checkpointAt?: string;
    sourceFreshness: string;
    populationCompletedAt: string;
  }) => Promise<void>;
}

export interface ISyncService {
  runSync(options?: SyncOptions): Promise<SyncSummary>;
  getLatestSyncRun?(): Promise<any>;
}
