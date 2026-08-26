export interface DashboardContext {
  scope: string;
  writeControlsEnabled: boolean;
  nowIso: string;
  nowMs: number;
  allowedWarehouseIds?: string[];
}

export interface IDashboardService {
  getDashboard(context: DashboardContext): Promise<any>;
}
