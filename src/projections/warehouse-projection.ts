import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectionResult } from "./projection-engine";
import { logger } from "@/observability/logger";

export interface WarehouseSummaryDto {
  warehouse_id: string;
  warehouse_name: string | null;
  active_incidents: number;
  critical_incidents: number;
  followups_waiting: number;
  notifications_pending: number;
  planner_drafts: number;
  average_age_hours: number | null;
  health: "healthy" | "warning" | "critical" | "stale" | null;
  last_sync: string | null;
}

/**
 * Builds and applies the Warehouse Projection read model.
 * 
 * Uses direct queries against order_snapshots, incidents, followup_cases, 
 * planner_runs, and notification_actions to build one warehouse_summary row per warehouse.
 */
export async function projectWarehouse(client: SupabaseClient): Promise<ProjectionResult> {
  const startTime = Date.now();

  try {
    // 1. Fetch latest successful sync run ID to get the current list of warehouses and order counts.
    const { data: latestSync, error: syncError } = await client
      .from("sync_runs")
      .select("id, completed_at")
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

    const syncRunId = latestSync.id;
    const lastSyncTime = latestSync.completed_at;

    // 2. Fetch distinct warehouses from order_snapshots of the latest sync run.
    const { data: snapshotWarehouses, error: whError } = await client
      .from("order_snapshots")
      .select("warehouse_id, warehouse_name, age_hours")
      .eq("sync_run_id", syncRunId);

    if (whError) {
      throw new Error(`Failed to query order snapshots for warehouses: ${whError.message}`);
    }

    if (!snapshotWarehouses || snapshotWarehouses.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Identify unique warehouses from the snapshot
    const warehouseMap = new Map<string, { name: string | null; totalAge: number; count: number }>();
    for (const row of snapshotWarehouses) {
      if (!row.warehouse_id) continue;
      const existing = warehouseMap.get(row.warehouse_id);
      const age = row.age_hours || 0;
      if (existing) {
        existing.totalAge += age;
        existing.count += 1;
        // Keep the non-null/non-empty name if available
        if (!existing.name && row.warehouse_name) {
          existing.name = row.warehouse_name;
        }
      } else {
        warehouseMap.set(row.warehouse_id, {
          name: row.warehouse_name || null,
          totalAge: age,
          count: 1,
        });
      }
    }

    const warehouseIds = Array.from(warehouseMap.keys());

    if (warehouseIds.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Query all open incidents in parallel to aggregate stats.
    const [incidentsRes, followupCasesRes, plannerRunsRes, notificationActionsRes] = await Promise.all([
      client.from("incidents").select("id, warehouse_id, priority_score").in("status", ["open", "monitoring"]),
      client.from("followup_cases").select("incident_id, current_state").in("current_state", ["NEW", "FIRST_PUSH_PENDING", "FIRST_PUSH_SENT", "FOLLOWING_UP", "SECOND_PUSH_PENDING", "SECOND_PUSH_SENT", "ESCALATION_PENDING", "ESCALATED"]),
      client.from("planner_runs").select("incident_id").eq("status", "DRAFT"),
      client.from("notification_actions").select("target_id").eq("status", "PENDING"),
    ]);

    if (incidentsRes.error) throw new Error(`Incidents query failed: ${incidentsRes.error.message}`);
    if (followupCasesRes.error) throw new Error(`Followup cases query failed: ${followupCasesRes.error.message}`);
    if (plannerRunsRes.error) throw new Error(`Planner runs query failed: ${plannerRunsRes.error.message}`);
    if (notificationActionsRes.error) throw new Error(`Notification actions query failed: ${notificationActionsRes.error.message}`);

    const activeIncidents = incidentsRes.data || [];
    const activeFollowups = followupCasesRes.data || [];
    const plannerDrafts = plannerRunsRes.data || [];
    const pendingNotifications = notificationActionsRes.data || [];

    // Map incident stats by incident ID for easy lookup
    const incidentWarehouseMap = new Map<string, string>();
    const warehouseActiveIncidents = new Map<string, number>();
    const warehouseCriticalIncidents = new Map<string, number>();

    for (const inc of activeIncidents) {
      if (!inc.warehouse_id) continue;
      incidentWarehouseMap.set(inc.id, inc.warehouse_id);

      warehouseActiveIncidents.set(inc.warehouse_id, (warehouseActiveIncidents.get(inc.warehouse_id) || 0) + 1);
      if (inc.priority_score >= 75) {
        warehouseCriticalIncidents.set(inc.warehouse_id, (warehouseCriticalIncidents.get(inc.warehouse_id) || 0) + 1);
      }
    }

    // Map other summary entities back to their warehouses via incident ID
    const warehouseFollowups = new Map<string, number>();
    for (const f of activeFollowups) {
      const whId = incidentWarehouseMap.get(f.incident_id);
      if (whId) {
        warehouseFollowups.set(whId, (warehouseFollowups.get(whId) || 0) + 1);
      }
    }

    const warehousePlannerDrafts = new Map<string, number>();
    for (const p of plannerDrafts) {
      const whId = incidentWarehouseMap.get(p.incident_id);
      if (whId) {
        warehousePlannerDrafts.set(whId, (warehousePlannerDrafts.get(whId) || 0) + 1);
      }
    }

    const warehousePendingNotifications = new Map<string, number>();
    for (const n of pendingNotifications) {
      const whId = incidentWarehouseMap.get(n.target_id);
      if (whId) {
        warehousePendingNotifications.set(whId, (warehousePendingNotifications.get(whId) || 0) + 1);
      }
    }

    // 4. Construct DTO rows for each warehouse
    const dtos: WarehouseSummaryDto[] = [];

    for (const warehouseId of warehouseIds) {
      const metadata = warehouseMap.get(warehouseId)!;
      const activeCount = warehouseActiveIncidents.get(warehouseId) || 0;
      const criticalCount = warehouseCriticalIncidents.get(warehouseId) || 0;
      const followupsCount = warehouseFollowups.get(warehouseId) || 0;
      const draftsCount = warehousePlannerDrafts.get(warehouseId) || 0;
      const notificationsCount = warehousePendingNotifications.get(warehouseId) || 0;

      const avgAge = metadata.count > 0 ? Math.round((metadata.totalAge / metadata.count) * 10) / 10 : null;

      // Deterministic health logic:
      // - Critical incidents > 0 => critical
      // - Active incidents > 0 => warning
      // - Else => healthy
      let health: "healthy" | "warning" | "critical" = "healthy";
      if (criticalCount > 0) {
        health = "critical";
      } else if (activeCount > 0) {
        health = "warning";
      }

      dtos.push({
        warehouse_id: warehouseId,
        warehouse_name: metadata.name,
        active_incidents: activeCount,
        critical_incidents: criticalCount,
        followups_waiting: followupsCount,
        notifications_pending: notificationsCount,
        planner_drafts: draftsCount,
        average_age_hours: avgAge,
        health,
        last_sync: lastSyncTime || null,
      });
    }

    if (dtos.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Invoke the RPC
    const { error: rpcError } = await client.rpc("upsert_warehouse_summary", {
      rows: dtos,
      present_ids: warehouseIds,
    });

    if (rpcError) {
      throw new Error(`RPC upsert_warehouse_summary failed: ${rpcError.message}`);
    }

    const rowsUpdated = dtos.length;
    const durationMs = Date.now() - startTime;

    logger.info({
      component: "WarehouseProjection",
      operation: "projectWarehouse",
      status: "success",
      message: `[Projection][Warehouse] finished rowsUpdated=${rowsUpdated}`,
      durationMs,
      metadata: {
        rowsProcessed: snapshotWarehouses.length,
        rowsUpdated,
        syncRunId,
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
      component: "WarehouseProjection",
      operation: "projectWarehouse",
      status: "failed",
      message: `[Projection][Warehouse] failed ${errorMessage}`,
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
