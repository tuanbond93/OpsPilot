import { createAdminClient } from "@/connectors/supabase";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import { ServiceFactory } from "@/services/ServiceFactory";

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
  console.log("[ProjectionEngine] Projection Engine started");

  let client;
  try {
    client = createAdminClient();
  } catch (err) {
    console.error("[ProjectionEngine] FATAL: createAdminClient() threw", err);
    if (isFallbackAllowed()) {
      console.log("[ProjectionEngine] Fallback allowed, skipping projection engine execution");
      return;
    }
    throw err;
  }

  const projectionService = ServiceFactory.getProjectionService(client);
  await projectionService.refreshProjections(params);

  console.log("[ProjectionEngine] Projection Engine finished");
}
