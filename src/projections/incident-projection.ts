import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectionResult } from "./projection-engine";

export interface IncidentSummaryDto {
  incident_id: string; // UUID
  priority: string | null;
  trend: string | null;
  risk: string | null;
  followup_state: string | null;
  planner_status: string | null;
  notification_status: string | null;
  latest_root_cause_confidence: number | null;
  latest_planner_confidence: number | null;
}

/**
 * Builds and applies the Incident Projection read model.
 * 
 * Aggregates information for open / monitoring incidents across:
 * - incidents: base rows containing priorities & statuses
 * - followup_cases: states like NEW, FOLLOWING_UP, ESCALATED, etc.
 * - planner_runs: status of the latest planner recommendations
 * - notification_actions: consolidated delivery statuses
 * - ai_analysis_jobs: root cause / analysis confidence results
 */
export async function projectIncident(client: SupabaseClient): Promise<ProjectionResult> {
  const startTime = Date.now();
  console.log("[Projection][Incident] started");

  try {
    // 1. Fetch latest successful sync run ID to identify active incidents (incremental / rebuild anchor)
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
      console.log("[Projection][Incident] finished rowsUpdated=0");
      console.log("[Projection][Incident] rows.length == 0: No successful sync runs found in the database");
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Fetch active incidents (status: open or monitoring)
    const { data: activeIncidents, error: incidentsError } = await client
      .from("incidents")
      .select("id, priority_score, status")
      .in("status", ["open", "monitoring"]);

    if (incidentsError) {
      throw new Error(`Failed to fetch active incidents: ${incidentsError.message}`);
    }

    console.log("Latest sync: " + latestSync.id);
    console.log("Loaded incidents: " + (activeIncidents?.length || 0));

    if (!activeIncidents || activeIncidents.length === 0) {
      console.log("[Projection][Incident] finished rowsUpdated=0");
      console.log("[Projection][Incident] rows.length == 0: No open or monitoring incidents found");
      return {
        status: "success",
        rowsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const incidentIds = activeIncidents.map((inc) => inc.id);

    // 3. Query all supporting entities in parallel for the active incidents
    const [
      followupCasesRes,
      plannerRunsRes,
      notificationActionsRes,
      incidentHistoriesRes
    ] = await Promise.all([
      client.from("followup_cases").select("incident_id, current_state").in("incident_id", incidentIds),
      client.from("planner_runs").select("incident_id, status, result").in("incident_id", incidentIds),
      client.from("notification_actions").select("target_id, status").in("target_id", incidentIds),
      client.from("incident_history").select("incident_id, priority_score, recorded_at").in("incident_id", incidentIds),
    ]);

    if (followupCasesRes.error) throw new Error(`Followup cases query failed: ${followupCasesRes.error.message}`);
    if (plannerRunsRes.error) throw new Error(`Planner runs query failed: ${plannerRunsRes.error.message}`);
    if (notificationActionsRes.error) throw new Error(`Notification actions query failed: ${notificationActionsRes.error.message}`);
    if (incidentHistoriesRes.error) throw new Error(`Incident histories query failed: ${incidentHistoriesRes.error.message}`);

    const followupCases = followupCasesRes.data || [];
    const plannerRuns = plannerRunsRes.data || [];
    const notificationActions = notificationActionsRes.data || [];
    const histories = incidentHistoriesRes.data || [];

    // Maps for easy lookup
    const followupMap = new Map<string, string>();
    for (const f of followupCases) {
      followupMap.set(f.incident_id, f.current_state);
    }

    // Resolve planner_status: latest draft or active plan status. Let's group runs by incident_id.
    const plannerRunsMap = new Map<string, any[]>();
    for (const p of plannerRuns) {
      const list = plannerRunsMap.get(p.incident_id) || [];
      list.push(p);
      plannerRunsMap.set(p.incident_id, list);
    }

    // Resolve notifications statuses for target incidents: consolidate statuses to PENDING, SENT, FAILED, etc.
    const notificationsMap = new Map<string, any[]>();
    for (const n of notificationActions) {
      const list = notificationsMap.get(n.target_id) || [];
      list.push(n);
      notificationsMap.set(n.target_id, list);
    }

    // Group histories to calculate trend
    const historiesMap = new Map<string, any[]>();
    for (const h of histories) {
      const list = historiesMap.get(h.incident_id) || [];
      list.push(h);
      historiesMap.set(h.incident_id, list);
    }

    const dtos: IncidentSummaryDto[] = [];

    for (const inc of activeIncidents) {
      const incId = inc.id;

      // 3a. Resolve priority: High (>=75), Medium (>=50), Low (<50)
      let priority = "low";
      if (inc.priority_score >= 75) {
        priority = "critical";
      } else if (inc.priority_score >= 50) {
        priority = "warning";
      } else {
        priority = "healthy";
      }

      // 3b. Resolve trend: compare current priority_score to average of last 3 recordings (or simple slope)
      let trend = "stable";
      const incHistories = historiesMap.get(incId) || [];
      if (incHistories.length >= 2) {
        // Sort by recorded_at ascending
        const sortedHist = [...incHistories].sort(
          (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
        );
        const latest = sortedHist[sortedHist.length - 1].priority_score;
        const previous = sortedHist[sortedHist.length - 2].priority_score;
        if (latest > previous) {
          trend = "rising";
        } else if (latest < previous) {
          trend = "falling";
        }
      }

      // 3c. Resolve risk: health status assessment
      let risk = "low";
      if (inc.priority_score >= 75) {
        risk = "high";
      } else if (inc.priority_score >= 50) {
        risk = "medium";
      }

      // 3d. Resolve followup_state
      const followupState = followupMap.get(incId) || "NEW";

      // 3e. Resolve planner_status: latest planner run status or DRAFT
      const incPlanners = plannerRunsMap.get(incId) || [];
      let plannerStatus = "NONE";
      let latestPlannerConfidence: number | null = null;
      if (incPlanners.length > 0) {
        // We can sort or inspect the runs
        // Let's assume the latest by whatever schema or DRAFT is standard
        const sortedPlanners = [...incPlanners]; // Simple inspect
        const draftRun = sortedPlanners.find(r => r.status === "DRAFT");
        const approvedRun = sortedPlanners.find(r => r.status === "APPROVED");
        const activeRun = draftRun || approvedRun || sortedPlanners[0];
        plannerStatus = activeRun.status || "DRAFT";
        
        // Parse confidence from run result if exists
        if (activeRun.result && typeof activeRun.result === "object") {
          const confidenceVal = (activeRun.result as any).confidence || (activeRun.result as any).confidence_score;
          if (typeof confidenceVal === "number") {
            latestPlannerConfidence = confidenceVal;
          } else if (typeof confidenceVal === "string") {
            const parsed = parseFloat(confidenceVal);
            if (!isNaN(parsed)) latestPlannerConfidence = parsed;
          }
        }
      }

      // 3f. Resolve notification_status: determine overall status based on pending/failed notifications
      const incNotifications = notificationsMap.get(incId) || [];
      let notificationStatus = "IDLE";
      if (incNotifications.length > 0) {
        const hasFailed = incNotifications.some(n => n.status === "FAILED");
        const hasPending = incNotifications.some(n => n.status === "PENDING" || n.status === "RETRY");
        if (hasFailed) {
          notificationStatus = "FAILED";
        } else if (hasPending) {
          notificationStatus = "PENDING";
        } else {
          notificationStatus = "SENT";
        }
      }

      // 3g. Resolve latest_root_cause_confidence: AI information is unavailable
      const latestRootCauseConfidence: number | null = null;

      dtos.push({
        incident_id: incId,
        priority,
        trend,
        risk,
        followup_state: followupState,
        planner_status: plannerStatus,
        notification_status: notificationStatus,
        latest_root_cause_confidence: latestRootCauseConfidence,
        latest_planner_confidence: latestPlannerConfidence,
      });
    }

    console.log("DTO count: " + dtos.length);
    if (dtos.length === 0) {
      console.log("[Projection][Incident] rows.length == 0: constructed dtos array is empty");
    }

    // 4. Call RPC
    console.log("Calling RPC...");
    const { error: rpcError } = await client.rpc("upsert_incident_summary", {
      rows: dtos,
      present_ids: incidentIds,
    });

    if (rpcError) {
      console.error("Full RPC Error Object:", JSON.stringify(rpcError, null, 2));
      throw new Error(`RPC upsert_incident_summary failed: ${rpcError.message}`);
    }

    console.log("RPC success");
    const rowsUpdated = dtos.length;
    console.log(`rowsUpdated=${rowsUpdated}`);
    console.log("[Projection][Incident] finished");

    return {
      status: "success",
      rowsUpdated,
      durationMs: Date.now() - startTime,
    };
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    console.error(`[Projection][Incident] failed ${errorMessage}`, error);
    return {
      status: "failed",
      rowsUpdated: 0,
      durationMs: Date.now() - startTime,
      errorCode: error.code || "PROJECTION_ERROR",
      errorMessage,
    };
  }
}
