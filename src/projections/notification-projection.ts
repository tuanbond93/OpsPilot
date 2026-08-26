import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectionResult } from "./projection-engine";
import { logger } from "@/observability/logger";

export interface NotificationSummaryDto {
  incident_id: string; // UUID
  pending: number; // Integer
  sent: number; // Integer
  failed: number; // Integer
  retry: number; // Integer
  simulation: boolean; // Boolean
  last_delivery: string | null; // Timestamp
}

/**
 * Builds and applies the Notification Projection read model.
 */
export async function projectNotification(client: SupabaseClient): Promise<ProjectionResult> {
  const startTime = Date.now();

  try {
    // 1. Fetch active incidents (status: open or monitoring) to know which ones are present
    const { data: activeIncidents, error: incidentsError } = await client
      .from("incidents")
      .select("id, incident_key")
      .in("status", ["open", "monitoring"]);

    if (incidentsError) {
      throw new Error(`Failed to fetch active incidents: ${incidentsError.message}`);
    }

    const incidentIds = (activeIncidents || []).map((inc) => inc.id);
    const incidentKeyToIdMap = new Map<string, string>();
    for (const inc of activeIncidents || []) {
      incidentKeyToIdMap.set(inc.incident_key, inc.id);
    }

    // 2. Query ALL notification actions (no sync_run filter)
    const { data: notificationActions, error: notificationActionsError } = await client
      .from("notification_actions")
      .select("id, target_id, status, provider, provider_response, processed_at, payload, created_at");

    if (notificationActionsError) {
      throw new Error(`Notification actions query failed: ${notificationActionsError.message}`);
    }

    // 3. Map notification actions to active incident IDs.
    // notification_actions has a target_id, but target_id could be a warehouse_id, or payload contains incident_id/incidentKey.
    const actionsByIncident = new Map<string, typeof notificationActions>();
    let unmappedCount = 0;

    for (const action of notificationActions || []) {
      let mappedIncidentId: string | null = null;

      // Check if target_id directly matches an active incident ID
      if (action.target_id && incidentIds.includes(action.target_id)) {
        mappedIncidentId = action.target_id;
      } else if (action.payload && typeof action.payload === "object") {
        // Try extracting incidentId or incidentKey from payload
        const payloadObj = action.payload as any;
        const payloadIncidentId = payloadObj.incidentId || payloadObj.incident_id;
        const payloadIncidentKey = payloadObj.incidentKey || payloadObj.incident_key;

        if (payloadIncidentId && incidentIds.includes(payloadIncidentId)) {
          mappedIncidentId = payloadIncidentId;
        } else if (payloadIncidentKey && incidentKeyToIdMap.has(payloadIncidentKey)) {
          mappedIncidentId = incidentKeyToIdMap.get(payloadIncidentKey)!;
        }
      }

      if (mappedIncidentId) {
        const list = actionsByIncident.get(mappedIncidentId) || [];
        list.push(action);
        actionsByIncident.set(mappedIncidentId, list);
      } else {
        unmappedCount++;
      }
    }

    const dtos: NotificationSummaryDto[] = [];
    const notificationIds: string[] = [];

    for (const incidentId of incidentIds) {
      const actions = actionsByIncident.get(incidentId) || [];
      if (actions.length === 0) {
        continue;
      }

      let pending = 0;
      let sent = 0;
      let failed = 0;
      let retry = 0;
      let simulation = false;
      let lastDelivery: string | null = null;

      for (const action of actions) {
        const status = action.status || "PENDING";
        if (status === "PENDING" || status === "PROCESSING") {
          pending++;
        } else if (status === "SENT") {
          sent++;
        } else if (status === "FAILED" || status === "CANCELLED" || status === "EXPIRED") {
          failed++;
        } else if (status === "RETRY") {
          retry++;
        }

        // Determine if simulation is true
        if (
          action.status === "SIMULATED" ||
          action.provider === "console" ||
          (action.provider_response && (action.provider_response as any).simulated === true)
        ) {
          simulation = true;
        }

        // Keep track of the most recent delivery timestamp (processed_at)
        if (action.processed_at) {
          if (!lastDelivery || new Date(action.processed_at).getTime() > new Date(lastDelivery).getTime()) {
            lastDelivery = action.processed_at;
          }
        }
      }

      dtos.push({
        incident_id: incidentId,
        pending,
        sent,
        failed,
        retry,
        simulation,
        last_delivery: lastDelivery,
      });
      notificationIds.push(incidentId);
    }

    if (dtos.length === 0) {
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const { error: rpcError } = await client.rpc("upsert_notification_summary", {
      rows: dtos,
      present_ids: notificationIds,
    });

    if (rpcError) {
      throw new Error(`RPC upsert_notification_summary failed: ${rpcError.message}`);
    }

    const rowsUpdated = dtos.length;
    const durationMs = Date.now() - startTime;

    logger.info({
      component: "NotificationProjection",
      operation: "projectNotification",
      status: "success",
      message: `[Projection][Notification] finished rowsUpdated=${rowsUpdated}`,
      durationMs,
      metadata: {
        rowsProcessed: notificationActions?.length || 0,
        rowsUpdated,
        unmappedActionsCount: unmappedCount,
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
      component: "NotificationProjection",
      operation: "projectNotification",
      status: "failed",
      message: `[Projection][Notification] failed ${errorMessage}`,
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
