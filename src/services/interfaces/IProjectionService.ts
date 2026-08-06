import type { ProjectionRefreshParams } from "@/projections/projection-engine";

export interface IProjectionService {
  refreshProjections(params?: ProjectionRefreshParams): Promise<void>;
  rebuildProjections(): Promise<void>;
  getLatestRun(): Promise<any>;
}