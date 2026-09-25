import type { SyncRunRow, SyncPhase } from "@/connectors/supabase/types";

export interface ISyncRunRepository {
  createSyncRun(startedAt?: string, options?: { id?: string; checkpointAt?: string }): Promise<SyncRunRow>;
  updatePhase(
    id: string,
    currentPhase: SyncPhase,
    completedPhases: SyncPhase[]
  ): Promise<SyncRunRow>;
  updateSuccess(
    id: string,
    params: {
      completedAt: string;
      fetchedOrderCount: number;
      normalizedOrderCount: number;
      incidentCount: number;
      durationMs: number;
      sourceUpdatedAt?: string | null;
    }
  ): Promise<SyncRunRow>;
  updateFailed(
    id: string,
    params: {
      completedAt: string;
      durationMs: number;
      errorCode: string;
      errorMessage: string;
    }
  ): Promise<SyncRunRow>;
  getUnfinishedSyncRun(): Promise<SyncRunRow | null>;
  getUnfinishedSyncRuns(limit?: number): Promise<SyncRunRow[]>;
  getLatestSyncRun(): Promise<SyncRunRow | null>;
  getLatestSyncRuns(limit?: number): Promise<SyncRunRow[]>;
  getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null>;
  getSyncRunForCheckpoint(checkpointAt: string): Promise<SyncRunRow | null>;
}
