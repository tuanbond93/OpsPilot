import { IDashboardRepository } from "../interfaces/IDashboardRepository";

export class MockDashboardRepository implements IDashboardRepository {
  async getIncidentSummaries(): Promise<any[]> { return []; }
  async getWarehouseSummaries(): Promise<any[]> { return []; }
  async getPlannerSummaries(): Promise<any[]> { return []; }
  async getNotificationSummaries(): Promise<any[]> { return []; }
  async getRecentFollowupEvents(limit: number): Promise<any[]> { return []; }
  async getRecentPlannerReviewEvents(limit: number): Promise<any[]> { return []; }
  async getRecentActionEvents(limit: number): Promise<any[]> { return []; }
}
