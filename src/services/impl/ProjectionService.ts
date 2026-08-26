import type { IProjectionService } from "../interfaces/IProjectionService";
import type { ProjectionRefreshParams } from "@/projections/projection-engine";
import type { IWarehouseProjection } from "@/projections/interfaces/IWarehouseProjection";
import type { IIncidentProjection } from "@/projections/interfaces/IIncidentProjection";
import type { IPlannerProjection } from "@/projections/interfaces/IPlannerProjection";
import type { INotificationProjection } from "@/projections/interfaces/INotificationProjection";
import type { IProjectionRunRepository } from "@/repositories/interfaces/IProjectionRunRepository";
import type { WorkflowResult } from "@/workflow/WorkflowResult";
import { logger } from '@/observability/logger';
import { ErrorCode } from '@/observability/errorCodes';
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
            logger.error({
              component: "ProjectionService",
              operation: "projectWarehouse",
              status: "error",
              message: "[ProjectionEngine] Warehouse Projection failed",
              errorCode: ErrorCode.PROJECTION_REFRESH_FAILED,
              error: new Error(res.errorMessage),
              metadata: { projection: "warehouse" }
            });
          }
        })
      );
    }

    if (this.incidentProjection) {
      promises.push(
        this.incidentProjection.project().then((res) => {
          if (res.status === "failed") {
            logger.error({
              component: "ProjectionService",
              operation: "projectIncident",
              status: "error",
              message: "[ProjectionEngine] Incident Projection failed",
              errorCode: ErrorCode.PROJECTION_REFRESH_FAILED,
              error: new Error(res.errorMessage),
              metadata: { projection: "incident" }
            });
          }
        })
      );
    }

    if (this.plannerProjection) {
      promises.push(
        this.plannerProjection.project().then((res) => {
          if (res.status === "failed") {
            logger.error({
              component: "ProjectionService",
              operation: "projectPlanner",
              status: "error",
              message: "[ProjectionEngine] Planner Projection failed",
              errorCode: ErrorCode.PROJECTION_REFRESH_FAILED,
              error: new Error(res.errorMessage),
              metadata: { projection: "planner" }
            });
          }
        })
      );
    }

    if (this.notificationProjection) {
      promises.push(
        this.notificationProjection.project().then((res) => {
          if (res.status === "failed") {
            logger.error({
              component: "ProjectionService",
              operation: "projectNotification",
              status: "error",
              message: "[ProjectionEngine] Notification Projection failed",
              errorCode: ErrorCode.PROJECTION_REFRESH_FAILED,
              error: new Error(res.errorMessage),
              metadata: { projection: "notification" }
            });
          }
        })
      );
    }

    try {
      await Promise.all(promises);
    } catch (e: any) {
      logger.error({
        component: "ProjectionService",
        operation: "refreshProjections",
        status: "error",
        message: "[ProjectionEngine] Projection engine encountered an execution error",
        errorCode: ErrorCode.PROJECTION_REFRESH_FAILED,
        error: e instanceof Error ? e : new Error(String(e)),
        metadata: {}
      });
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
