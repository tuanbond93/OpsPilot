import { IDashboardRepository } from "../interfaces/IDashboardRepository";

export class MockDashboardRepository implements IDashboardRepository {
  async getIncidentSummaries(): Promise<any[]> { return []; }
  async getWarehouseSummaries(): Promise<any[]> { return []; }
  async getNotificationSummaries(): Promise<any[]> { return []; }
}
