import { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository } from "../base/BaseRepository";
import { IDashboardRepository } from "../interfaces/IDashboardRepository";

export const DASHBOARD_HISTORY_LIMIT_PER_INCIDENT = 2;
export const DASHBOARD_EVENT_LIMIT = 30;

const FOLLOWUP_EVENT_COLUMNS = "id, followup_case_id, event_type, event_time, old_state, new_state, assessment, notes, confirmed_by, created_at";
const ACTION_EVENT_COLUMNS = "id, action_id, event_type, created_at, old_status, new_status, provider";
const PLANNER_REVIEW_EVENT_COLUMNS = "id, planner_run_id, event_type, created_at, note, actor";

export class SupabaseDashboardRepository extends BaseRepository implements IDashboardRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async getIncidentSummaries(): Promise<any[]> {
    const [summaries, incidents, followups] = await Promise.all([
      this.executeMany<any>(this.client.from("incident_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getIncidentSummaries.summary", tableOrRpc: "incident_summary" }),
      this.executeMany<any>(this.client.from("incidents").select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, status, priority_score, first_detected_at, last_detected_at") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getIncidentSummaries.incidents", tableOrRpc: "incidents" }),
      this.executeMany<any>(this.client.from("followup_cases").select("incident_id, current_state, resolved_at, closed_at, updated_at") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getIncidentSummaries.followups", tableOrRpc: "followup_cases" }),
    ]);

    const incidentIds = Array.from(new Set(
      summaries
        .map((summary) => summary.incident_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ));
    const histories = incidentIds.length === 0
      ? []
      : await this.executeMany<any>(this.client.rpc("get_recent_incident_histories", {
        p_incident_ids: incidentIds,
        p_limit_per_incident: DASHBOARD_HISTORY_LIMIT_PER_INCIDENT,
      }) as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getIncidentSummaries.histories", tableOrRpc: "rpc:get_recent_incident_histories" });

    const incidentById = new Map(incidents.map((row) => [row.id, row]));
    const followupByIncidentId = new Map(followups.map((row) => [row.incident_id, row]));
    const historiesByIncident = new Map<string, any[]>();
    for (const row of histories) {
      const incidentHistories = historiesByIncident.get(row.incident_id) || [];
      incidentHistories.push(row);
      historiesByIncident.set(row.incident_id, incidentHistories);
    }
    for (const incidentHistories of historiesByIncident.values()) {
      incidentHistories.sort((a, b) => {
        const recordedAtDifference = Date.parse(String(b.recorded_at)) - Date.parse(String(a.recorded_at));
        if (recordedAtDifference !== 0) return recordedAtDifference;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
    }

    return summaries.map((summary) => {
      const incident = incidentById.get(summary.incident_id) || {};
      const incidentHistories = historiesByIncident.get(summary.incident_id) || [];
      const history = incidentHistories[0] || {};
      const previousHistory = incidentHistories[1] || {};
      const followup = followupByIncidentId.get(summary.incident_id) || {};
      return {
        ...summary,
        ...incident,
        affected_order_count: history.affected_order_count ?? 0,
        average_age_hours: history.average_age_hours ?? null,
        maximum_age_hours: history.maximum_age_hours ?? null,
        oldest_order_code: history.oldest_order_code ?? null,
        sample_order_codes: history.sample_order_codes ?? [],
        latest_snapshot_at: history.recorded_at ?? null,
        previous_affected_order_count: previousHistory.affected_order_count ?? null,
        previous_snapshot_at: previousHistory.recorded_at ?? null,
        followup_state: followup.current_state ?? summary.followup_state,
        followup_resolved_at: followup.resolved_at ?? null,
        followup_closed_at: followup.closed_at ?? null,
      };
    });
  }

  async getWarehouseSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("warehouse_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getWarehouseSummaries", tableOrRpc: "warehouse_summary" });
  }

  async getPlannerSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("planner_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getPlannerSummaries", tableOrRpc: "planner_summary" });
  }

  async getNotificationSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("notification_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getNotificationSummaries", tableOrRpc: "notification_summary" });
  }

  async getTelegramFollowupRemindersUpdatedSince(sinceIso: string): Promise<any[]> {
    return this.executeMany(this.client.from("telegram_followup_reminders")
      .select("id, followup_case_id, status, sent_at, updated_at")
      .gte("updated_at", sinceIso) as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getTelegramFollowupRemindersUpdatedSince", tableOrRpc: "telegram_followup_reminders" });
  }

  async getRecentFollowupEvents(limit: number): Promise<any[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DASHBOARD_EVENT_LIMIT, 1), DASHBOARD_EVENT_LIMIT);
    return this.executeMany(this.client.from("followup_events").select(FOLLOWUP_EVENT_COLUMNS).order("created_at", { ascending: false }).limit(boundedLimit) as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getRecentFollowupEvents", tableOrRpc: "followup_events" });
  }

  async getRecentActionEvents(limit: number): Promise<any[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DASHBOARD_EVENT_LIMIT, 1), DASHBOARD_EVENT_LIMIT);
    return this.executeMany(this.client.from("notification_action_events").select(ACTION_EVENT_COLUMNS).order("created_at", { ascending: false }).limit(boundedLimit) as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getRecentActionEvents", tableOrRpc: "notification_action_events" });
  }

  async getRecentPlannerReviewEvents(limit: number): Promise<any[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DASHBOARD_EVENT_LIMIT, 1), DASHBOARD_EVENT_LIMIT);
    return this.executeMany(this.client.from("planner_review_events").select(PLANNER_REVIEW_EVENT_COLUMNS).order("created_at", { ascending: false }).limit(boundedLimit) as unknown as Promise<{ data: any[] | null; error: any }>, { operation: "Dashboard.getRecentPlannerReviewEvents", tableOrRpc: "planner_review_events" });
  }
}
