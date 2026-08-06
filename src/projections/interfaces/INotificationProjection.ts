import type { ProjectionResult } from "../projection-engine";

export interface INotificationProjection {
  project(): Promise<ProjectionResult>;
}
