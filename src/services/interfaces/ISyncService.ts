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
  /** Invoked immediately after checkpoint history is durably committed and BEFORE Phase 6 followups. */
  onCheckpointHistoryPersisted?: (context: {
    syncRunId: string;
    checkpointAt: string;
    orderCount: number;
    incidentCount: number;
    orders: any[];
  }) => Promise<void>;
  /** Saves exact V1 follow-up inputs after incident identities are persisted. */
  onDurableV1InputReady?: (context: {
    syncRunId: string;
    checkpointAt: string;
    referenceTimeMs: number;
    orders: any[];
    incidents: any[];
  }) => Promise<void>;
  /** Seeds V1 work after history is durable; failure must stop the producer. */
  onDurableV1CheckpointReady?: (context: { syncRunId: string; checkpointAt: string }) => Promise<void>;
  /** Exact producer inputs and journaled results for post-drain continuation. */
  durableV1Finalization?: { incidents: any[]; followupResults: any[] };
}

export interface ISyncService {
  runSync(options?: SyncOptions): Promise<SyncSummary>;
  getLatestSyncRun?(): Promise<any>;
}
