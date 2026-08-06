import { createAdminClient } from "@/connectors/supabase";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import { projectWarehouse } from "./warehouse-projection";
import { projectIncident } from "./incident-projection";
import { projectPlanner } from "./planner-projection";
import { projectNotification } from "./notification-projection";

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

  // Phase 5 Parallel Executions
  try {
    await Promise.all([
      projectWarehouse(client).then(res => {
        if (res.status === "failed") {
          console.error(`[ProjectionEngine] Warehouse Projection failed: ${res.errorMessage}`);
        }
      }),
      projectIncident(client).then(res => {
        if (res.status === "failed") {
          console.error(`[ProjectionEngine] Incident Projection failed: ${res.errorMessage}`);
        }
      }),
      projectPlanner(client).then(res => {
        if (res.status === "failed") {
          console.error(`[ProjectionEngine] Planner Projection failed: ${res.errorMessage}`);
        }
      }),
      projectNotification(client).then(res => {
        if (res.status === "failed") {
          console.error(`[ProjectionEngine] Notification Projection failed: ${res.errorMessage}`);
        }
      })
    ]);
  } catch (e: any) {
    console.error(`[ProjectionEngine] Projection engine encountered a execution error: ${e.message || e}`);
  }

  console.log("[ProjectionEngine] Projection Engine finished");
}
