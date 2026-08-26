import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectionResult } from "./projection-engine";
import { logger } from "@/observability/logger";

export interface PlannerSummaryDto {
  incident_id: string; // UUID
  recommendation: any; // JSONB
  approval_state: string; // Text
  confidence: number | null; // Numeric
  next_review: string | null; // Timestamp
  review_actor: string | null; // Text
}

/**
 * Builds and applies the Planner Projection read model.
 */
export async function projectPlanner(client: SupabaseClient): Promise<ProjectionResult> {
  const startTime = Date.now();

  try {
    // 1. Fetch latest successful sync run ID to identify active incidents
    const { data: latestSync, error: syncError } = await client
      .from("sync_runs")
      .select("id")
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (syncError) {
      throw new Error(`Failed to fetch latest successful sync run: ${syncError.message}`);
    }

    if (!latestSync) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Fetch active incidents (status: open or monitoring)
    const { data: activeIncidents, error: incidentsError } = await client
      .from("incidents")
      .select("id")
      .in("status", ["open", "monitoring"]);

    if (incidentsError) {
      throw new Error(`Failed to fetch active incidents: ${incidentsError.message}`);
    }

    const incidentIds = (activeIncidents || []).map((inc) => inc.id);

    if (incidentIds.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Query planner runs for the active incidents
    const { data: plannerRuns, error: plannerRunsError } = await client
      .from("planner_runs")
      .select("id, incident_id, status, result, reviewed_at, reviewed_by, created_at")
      .in("incident_id", incidentIds);

    if (plannerRunsError) {
      throw new Error(`Planner runs query failed: ${plannerRunsError.message}`);
    }

    // Group runs by incident_id
    const runsByIncident = new Map<string, typeof plannerRuns>();
    for (const run of (plannerRuns || [])) {
      const list = runsByIncident.get(run.incident_id) || [];
      list.push(run);
      runsByIncident.set(run.incident_id, list);
    }

    const dtos: PlannerSummaryDto[] = [];
    const plannerIds: string[] = [];

    for (const incidentId of incidentIds) {
      const runs = runsByIncident.get(incidentId) || [];
      if (runs.length === 0) {
        continue;
      }

      // Find latest planner run by created_at
      const sorted = [...runs].sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
      const latestRun = sorted[0];

      // Parse confidence from result
      let confidence: number | null = null;
      if (latestRun.result && typeof latestRun.result === "object") {
        const confVal = (latestRun.result as any).confidence ?? (latestRun.result as any).confidence_score;
        if (typeof confVal === "number") {
          confidence = confVal;
        } else if (typeof confVal === "string") {
          const parsed = parseFloat(confVal);
          if (!isNaN(parsed)) {
            confidence = parsed;
          }
        }
      }

      // Parse next_review from result if exists
      let nextReview: string | null = null;
      if (latestRun.result && typeof latestRun.result === "object") {
        const nrVal = (latestRun.result as any).next_review ?? (latestRun.result as any).next_review_at;
        if (typeof nrVal === "string" && nrVal.trim() !== "") {
          nextReview = nrVal;
        }
      }

      // approval_state is planner_runs.status
      const approvalState = latestRun.status || "DRAFT";
      // review_actor is reviewed_by
      const reviewActor = latestRun.reviewed_by || null;

      dtos.push({
        incident_id: incidentId,
        recommendation: latestRun.result || {},
        approval_state: approvalState,
        confidence,
        next_review: nextReview,
        review_actor: reviewActor,
      });
      plannerIds.push(incidentId);
    }

    if (dtos.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const { error: rpcError } = await client.rpc("upsert_planner_summary", {
      rows: dtos,
      present_ids: plannerIds,
    });

    if (rpcError) {
      throw new Error(`RPC upsert_planner_summary failed: ${rpcError.message}`);
    }

    const rowsUpdated = dtos.length;
    const durationMs = Date.now() - startTime;

    logger.info({
      component: "PlannerProjection",
      operation: "projectPlanner",
      status: "success",
      message: `[Projection][Planner] finished rowsUpdated=${rowsUpdated}`,
      durationMs,
      metadata: {
        rowsProcessed: plannerRuns?.length || 0,
        rowsUpdated,
        syncRunId: latestSync.id,
      },
    });

    return {
      status: "success",
      rowsUpdated,
      durationMs,
    };
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    const durationMs = Date.now() - startTime;
    const errorCode = error.code || "PROJECTION_REFRESH_FAILED";

    logger.error({
      component: "PlannerProjection",
      operation: "projectPlanner",
      status: "failed",
      message: `[Projection][Planner] failed ${errorMessage}`,
      durationMs,
      errorCode,
      error,
    });

    return {
      status: "failed",
      rowsUpdated: 0,
      durationMs,
      errorCode,
      errorMessage,
    };
  }
}
