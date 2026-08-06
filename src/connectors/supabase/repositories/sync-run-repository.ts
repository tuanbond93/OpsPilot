import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncRunRow } from "../types";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export class SyncRunRepository {
  constructor(private client?: SupabaseClient | null) {
    // Preserves signature. If a custom client is explicitly supplied,
    // the RepositoryFactory resolves a dedicated SupabaseSyncRunRepository using it.
  }

  clearMemory(): void {
    const repo = RepositoryFactory.getSyncRunRepository(this.client);
    if (repo && typeof (repo as any).clearMemory === "function") {
      (repo as any).clearMemory();
    }
  }

  async createSyncRun(startedAt?: string): Promise<SyncRunRow> {
    return RepositoryFactory.getSyncRunRepository(this.client).createSyncRun(startedAt);
  }

  async updateSuccess(
    id: string,
    params: {
      completedAt: string;
      fetchedOrderCount: number;
      normalizedOrderCount: number;
      incidentCount: number;
      durationMs: number;
      sourceUpdatedAt?: string | null;
    }
  ): Promise<SyncRunRow> {
    return RepositoryFactory.getSyncRunRepository(this.client).updateSuccess(id, params);
  }

  async updateFailed(
    id: string,
    params: {
      completedAt: string;
      durationMs: number;
      errorCode: string;
      errorMessage: string;
    }
  ): Promise<SyncRunRow> {
    return RepositoryFactory.getSyncRunRepository(this.client).updateFailed(id, params);
  }

  async getLatestSyncRun(): Promise<SyncRunRow | null> {
    return RepositoryFactory.getSyncRunRepository(this.client).getLatestSyncRun();
  }

  async getLatestSyncRuns(limit?: number): Promise<SyncRunRow[]> {
    return RepositoryFactory.getSyncRunRepository(this.client).getLatestSyncRuns(limit);
  }

  async getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null> {
    return RepositoryFactory.getSyncRunRepository(this.client).getPreviousSuccessfulSyncRun(currentSyncRunId);
  }
}
