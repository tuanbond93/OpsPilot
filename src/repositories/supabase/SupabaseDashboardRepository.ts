import { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository } from "../base/BaseRepository";
import { IDashboardRepository } from "../interfaces/IDashboardRepository";

export class SupabaseDashboardRepository extends BaseRepository implements IDashboardRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async getIncidentSummaries(): Promise<any[]> {
    const [summaries, incidents, histories] = await Promise.all([
      this.executeMany<any>(this.client.from("incident_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>),
      this.executeMany<any>(this.client.from("incidents").select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, status, priority_score, first_detected_at, last_detected_at") as unknown as Promise<{ data: any[] | null; error: any }>),
      this.executeMany<any>(this.client.from("incident_history").select("incident_id, recorded_at, affected_order_count, average_age_hours, maximum_age_hours, oldest_order_code, sample_order_codes").order("recorded_at", { ascending: false }) as unknown as Promise<{ data: any[] | null; error: any }>),
    ]);
    const incidentById = new Map(incidents.map((row) => [row.id, row]));
    const latestHistoryByIncident = new Map<string, any>();
    const previousHistoryByIncident = new Map<string, any>();
    for (const row of histories) {
      if (!latestHistoryByIncident.has(row.incident_id)) latestHistoryByIncident.set(row.incident_id, row);
      else if (!previousHistoryByIncident.has(row.incident_id)) previousHistoryByIncident.set(row.incident_id, row);
    }
    return summaries.map((summary) => {
      const incident = incidentById.get(summary.incident_id) || {};
      const history = latestHistoryByIncident.get(summary.incident_id) || {};
      const previousHistory = previousHistoryByIncident.get(summary.incident_id) || {};
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
      };
    });
  }
  async getWarehouseSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("warehouse_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>);
  }
  async getPlannerSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("planner_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>);
  }
  async getNotificationSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("notification_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>);
  }
  async getRecentFollowupEvents(limit: number): Promise<any[]> {
    return this.executeMany(this.client.from("followup_events").select("*").order("created_at", { ascending: false }).limit(limit) as unknown as Promise<{ data: any[] | null; error: any }>);
  }
  async getRecentActionEvents(limit: number): Promise<any[]> {
    return this.executeMany(this.client.from("notification_action_events").select("*").order("created_at", { ascending: false }).limit(limit) as unknown as Promise<{ data: any[] | null; error: any }>);
  }
  async getRecentPlannerReviewEvents(limit: number): Promise<any[]> {
    return this.executeMany(this.client.from("planner_review_events").select("*").order("created_at", { ascending: false }).limit(limit) as unknown as Promise<{ data: any[] | null; error: any }>);
  }
}
