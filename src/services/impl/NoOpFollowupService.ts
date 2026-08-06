import { IFollowupService } from '../interfaces/IFollowupService';
export class NoOpFollowupService implements IFollowupService {
  async processFollowups(): Promise<void> { throw new Error('Not implemented yet: FollowupService.processFollowups'); }
  async getFollowupHistory(incidentId: string): Promise<any[]> { throw new Error('Not implemented yet: FollowupService.getFollowupHistory'); }
}