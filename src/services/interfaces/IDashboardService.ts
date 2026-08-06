export interface DashboardContext {
  scope: string;
  writeControlsEnabled: boolean;
  nowIso: string;
  nowMs: number;
}

export interface IDashboardService {
  getDashboard(context: DashboardContext): Promise<any>;
}