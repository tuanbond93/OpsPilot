import { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository } from "../base/BaseRepository";
import { IDashboardRepository } from "../interfaces/IDashboardRepository";

const INCIDENT_LIMIT = 200;

export class SupabaseDashboardRepository extends BaseRepository implements IDashboardRepository {
  constructor(client: SupabaseClient) { super(client); }

  async getIncidentSummaries(allowedWarehouseIds?: string[], scope?: string): Promise<any[]> {
    if (allowedWarehouseIds && allowedWarehouseIds.length === 0) return [];
    let query = this.client.from("incidents")
      .select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, status, priority_score, first_detected_at, last_detected_at, incident_history(recorded_at, affected_order_count, average_age_hours, maximum_age_hours, oldest_order_code, sample_order_codes), incident_triage_evaluations(route, triage_reason, evidence, created_at), followup_cases!fk_followup_cases_incident(incident_id, current_state, resolved_at, closed_at, last_checked_at, current_progress_percent, current_assessment, next_action_at), planner_runs(status, created_at)")
      .in("status", ["open", "monitoring"])
      .order("priority_score", { ascending: false })
      .limit(INCIDENT_LIMIT)
      .order("recorded_at", { referencedTable: "incident_history", ascending: false })
      .limit(2, { referencedTable: "incident_history" })
      .order("created_at", { referencedTable: "incident_triage_evaluations", ascending: false })
      .limit(1, { referencedTable: "incident_triage_evaluations" })
      .order("created_at", { referencedTable: "planner_runs", ascending: false })
      .limit(1, { referencedTable: "planner_runs" });
    if (allowedWarehouseIds) query = query.in("warehouse_id", allowedWarehouseIds);
    else if (scope && scope !== "all" && !scope.startsWith("zone:") && !scope.startsWith("pic:")) query = query.eq("warehouse_id", scope);

    const incidents = await this.executeMany<any>(query as any);
    return incidents.map((incident) => {
      const histories = Array.isArray(incident.incident_history) ? incident.incident_history : [];
      const latest = histories[0] || {};
      const previous = histories[1] || {};
      const triageRow = Array.isArray(incident.incident_triage_evaluations) ? incident.incident_triage_evaluations[0] : null;
      const plannerRows = Array.isArray(incident.planner_runs) ? incident.planner_runs : [];
      const plannerRow = plannerRows[0] || null;
      const followupRelation = incident.followup_cases;
      const followup = Array.isArray(followupRelation) ? followupRelation[0] || {} : followupRelation || {};
      return {
        incident_id: incident.id, incident_key: incident.incident_key,
        warehouse_id: incident.warehouse_id, warehouse_name: incident.warehouse_name,
        reason_code: incident.reason_code, reason_name: incident.reason_name,
        status: incident.status, priority_score: incident.priority_score,
        first_detected_at: incident.first_detected_at, last_detected_at: incident.last_detected_at,
        affected_order_count: latest.affected_order_count ?? 0,
        average_age_hours: latest.average_age_hours ?? null,
        maximum_age_hours: latest.maximum_age_hours ?? null,
        oldest_order_code: latest.oldest_order_code ?? null,
        sample_order_codes: latest.sample_order_codes ?? [],
        latest_snapshot_at: latest.recorded_at ?? null,
        previous_affected_order_count: previous.affected_order_count ?? null,
        previous_snapshot_at: previous.recorded_at ?? null,
        followup_state: followup.current_state ?? "NEW",
        followup_resolved_at: followup.resolved_at ?? null,
        followup_closed_at: followup.closed_at ?? null,
        followup_progress_percent: followup.current_progress_percent ?? null,
        followup_assessment: followup.current_assessment ?? null,
        followup_next_action_at: followup.next_action_at ?? null,
        followup_last_checked_at: followup.last_checked_at ?? null,
        planner_status: plannerRow?.status || "NONE",
        triage: triageRow ? { route: triageRow.route, triageReason: triageRow.triage_reason, evidence: triageRow.evidence || {} } : null,
      };
    });
  }

  async getWarehouseSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("warehouse_summary").select("*").order("updated_at", { ascending: false }).limit(200) as any);
  }
  async getNotificationSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("notification_summary").select("*").order("updated_at", { ascending: false }).limit(200) as any);
  }
}
