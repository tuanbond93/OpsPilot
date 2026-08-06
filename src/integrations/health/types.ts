export type HealthStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

export interface ComponentHealth {
  status: HealthStatus;
  healthReason: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  freshnessSeconds: number | null;
}

export interface HealthCheckable {
  name: string;
  health(): Promise<ComponentHealth>;
}
