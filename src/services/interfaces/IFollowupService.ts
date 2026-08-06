export interface IFollowupService {
  processFollowups(): Promise<void>;
  getFollowupHistory(incidentId: string): Promise<any[]>;
}