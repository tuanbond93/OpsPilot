import type { INotificationProjection } from "../interfaces/INotificationProjection";
import type { ProjectionResult } from "../projection-engine";
import { projectNotification } from "../notification-projection";

export class SupabaseNotificationProjection implements INotificationProjection {
  constructor(private client: any) {}

  async project(): Promise<ProjectionResult> {
    return projectNotification(this.client);
  }
}
