import type { IPlannerProjection } from "../interfaces/IPlannerProjection";
import type { ProjectionResult } from "../projection-engine";
import { projectPlanner } from "../planner-projection";

export class SupabasePlannerProjection implements IPlannerProjection {
  constructor(private client: any) {}

  async project(): Promise<ProjectionResult> {
    return projectPlanner(this.client);
  }
}
