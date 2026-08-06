import type { ISyncService, SyncOptions, SyncSummary } from "../interfaces/ISyncService";

export class NoOpSyncService implements ISyncService {
  async runSync(_options?: SyncOptions): Promise<SyncSummary> {
    throw new Error("Not implemented yet: SyncService.runSync");
  }
  async getLatestSyncRun(): Promise<any> {
    throw new Error("Not implemented yet: SyncService.getLatestSyncRun");
  }
}