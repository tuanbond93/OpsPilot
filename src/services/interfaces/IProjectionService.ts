import type { ProjectionRefreshParams } from "@/projections/projection-engine";
import type { WorkflowResult } from "@/workflow/WorkflowResult";

export interface IProjectionService {
  refreshProjections(params?: ProjectionRefreshParams): Promise<void>;
  rebuildProjections(): Promise<void>;
  getLatestRun(): Promise<any>;

}