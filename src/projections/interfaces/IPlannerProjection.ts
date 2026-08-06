import type { ProjectionResult } from "../projection-engine";

export interface IPlannerProjection {
  project(): Promise<ProjectionResult>;
}
