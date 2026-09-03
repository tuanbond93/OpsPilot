export interface IDashboardRepository {
  getIncidentSummaries(): Promise<any[]>;
  getWarehouseSummaries(): Promise<any[]>;
  getPlannerSummaries(): Promise<any[]>;
  getNotificationSummaries(): Promise<any[]>;
  getTelegramFollowupRemindersUpdatedSince(sinceIso: string): Promise<any[]>;
  getRecentFollowupEvents(limit: number): Promise<any[]>;
  getRecentPlannerReviewEvents(limit: number): Promise<any[]>;
  getRecentActionEvents(limit: number): Promise<any[]>;
}
