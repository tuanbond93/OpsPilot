import type { IProjectionService } from "../interfaces/IProjectionService";
import type { ProjectionRefreshParams } from "@/projections/projection-engine";
import type { IWarehouseProjection } from "@/projections/interfaces/IWarehouseProjection";
import type { IIncidentProjection } from "@/projections/interfaces/IIncidentProjection";
import type { IPlannerProjection } from "@/projections/interfaces/IPlannerProjection";
import type { INotificationProjection } from "@/projections/interfaces/INotificationProjection";
import type { IProjectionRunRepository } from "@/repositories/interfaces/IProjectionRunRepository";

export class ProjectionService implements IProjectionService {
  constructor(
    private warehouseProjection: IWarehouseProjection | null = null,
    private incidentProjection: IIncidentProjection | null = null,
    private plannerProjection: IPlannerProjection | null = null,
    private notificationProjection: INotificationProjection | null = null,
    private projectionRunRepo: IProjectionRunRepository | null = null
  ) {}

  async refreshProjections(_params?: ProjectionRefreshParams): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.warehouseProjection) {
      promises.push(
        this.warehouseProjection.project().then((res) => {
          if (res.status === "failed") {
            console.error(`[ProjectionEngine] Warehouse Projection failed: ${res.errorMessage}`);
          }
        })
      );
    }

    if (this.incidentProjection) {
      promises.push(
        this.incidentProjection.project().then((res) => {
          if (res.status === "failed") {
            console.error(`[ProjectionEngine] Incident Projection failed: ${res.errorMessage}`);
          }
        })
      );
    }

    if (this.plannerProjection) {
      promises.push(
        this.plannerProjection.project().then((res) => {
          if (res.status === "failed") {
            console.error(`[ProjectionEngine] Planner Projection failed: ${res.errorMessage}`);
          }
        })
      );
    }

    if (this.notificationProjection) {
      promises.push(
        this.notificationProjection.project().then((res) => {
          if (res.status === "failed") {
            console.error(`[ProjectionEngine] Notification Projection failed: ${res.errorMessage}`);
          }
        })
      );
    }

    try {
      await Promise.all(promises);
    } catch (e: any) {
      console.error(`[ProjectionEngine] Projection engine encountered a execution error: ${e.message || e}`);
    }
  }

  async rebuildProjections(): Promise<void> {
    return this.refreshProjections();
  }

  async getLatestRun(): Promise<any> {
    if (!this.projectionRunRepo) return null;
    return this.projectionRunRepo.getLatestRun();
  }
}
