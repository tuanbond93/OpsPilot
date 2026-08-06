import { ISyncService } from '../interfaces/ISyncService';
export class NoOpSyncService implements ISyncService {
  async runSync(): Promise<void> { throw new Error('Not implemented yet: SyncService.runSync'); }
  async getLatestSyncRun(): Promise<any> { throw new Error('Not implemented yet: SyncService.getLatestSyncRun'); }
}