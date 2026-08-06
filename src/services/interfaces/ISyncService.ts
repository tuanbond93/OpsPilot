export interface ISyncService {
  runSync(): Promise<void>;
  getLatestSyncRun(): Promise<any>;
}