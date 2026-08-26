import { createAdminClient } from "@/connectors/supabase";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import { ServiceFactory } from "@/services/ServiceFactory";
import { logger } from "@/observability/logger";

export interface ProjectionRefreshParams {
  source: string; // e.g., 'sync', 'planner', 'followup', 'notification'
  changedIncidentIds: string[];
  changedWarehouseIds: string[];
}

export interface ProjectionResult {
  status: "success" | "failed";
  rowsUpdated: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Refresh read-model projections deterministically.
 */
export async function refresh(params: ProjectionRefreshParams): Promise<void> {
  const startTime = Date.now();

  let client;
  try {
    client = createAdminClient();
  } catch (err: any) {
    logger.error({
      component: "ProjectionEngine",
      operation: "refresh",
      status: "failed",
      message: "[ProjectionEngine] FATAL: createAdminClient() threw",
      errorCode: "PROJECTION_REFRESH_FAILED",
      error: err,
    });
    if (isFallbackAllowed()) {
      logger.info({
        component: "ProjectionEngine",
        operation: "refresh",
        status: "skipped",
        message: "[ProjectionEngine] Fallback allowed, skipping projection engine execution",
      });
      return;
    }
    throw err;
  }

  const projectionService = ServiceFactory.getProjectionService(client);
  await projectionService.refreshProjections(params);

  logger.info({
    component: "ProjectionEngine",
    operation: "refresh",
    status: "success",
    message: "[ProjectionEngine] Projection Engine finished",
    durationMs: Date.now() - startTime,
    metadata: {
      source: params.source,
      changedIncidentsCount: params.changedIncidentIds.length,
      changedWarehousesCount: params.changedWarehouseIds.length,
    },
  });
}
