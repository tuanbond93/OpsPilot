import type { IWarehouseProjection } from "../interfaces/IWarehouseProjection";
import type { ProjectionResult } from "../projection-engine";
import { projectWarehouse } from "../warehouse-projection";

export class SupabaseWarehouseProjection implements IWarehouseProjection {
  constructor(private client: any) {}

  async project(): Promise<ProjectionResult> {
    return projectWarehouse(this.client);
  }
}
