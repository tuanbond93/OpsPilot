// Dashboard Service Contract
export interface IDashboardService {
  /** Retrieve dashboard data. */
  getDashboard(params?: any): Promise<any>;
}
