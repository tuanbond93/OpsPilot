import type { ProjectionResult } from "../projection-engine";

export interface IWarehouseProjection {
  project(): Promise<ProjectionResult>;
}
