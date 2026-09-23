export interface IDashboardRepository {
  getIncidentSummaries(allowedWarehouseIds?: string[], scope?: string): Promise<any[]>;
  getWarehouseSummaries(): Promise<any[]>;
  getNotificationSummaries(): Promise<any[]>;
}
