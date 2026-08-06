import type { ProjectionResult } from "../projection-engine";

export interface IIncidentProjection {
  project(): Promise<ProjectionResult>;
}
