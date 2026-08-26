import type { SyncJobResult } from "@/jobs/sync-rillnet";

export type SyncSummary = SyncJobResult;

export interface SyncOptions {
  referenceTimeMs?: number;
  forceReprocessSource?: boolean;
}

export interface ISyncService {
  runSync(options?: SyncOptions): Promise<SyncSummary>;
  getLatestSyncRun?(): Promise<any>;
}
