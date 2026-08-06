import type { IIncidentProjection } from "../interfaces/IIncidentProjection";
import type { ProjectionResult } from "../projection-engine";
import { projectIncident } from "../incident-projection";

export class SupabaseIncidentProjection implements IIncidentProjection {
  constructor(private client: any) {}

  async project(): Promise<ProjectionResult> {
    return projectIncident(this.client);
  }
}
