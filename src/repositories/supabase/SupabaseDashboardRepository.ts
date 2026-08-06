import { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository } from "../base/BaseRepository";
import { IDashboardRepository } from "../interfaces/IDashboardRepository";

export class SupabaseDashboardRepository extends BaseRepository implements IDashboardRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async getIncidentSummaries(): Promise<any[]> {
    return this.executeMany(this.client.from("incident_summary").select("*") as unknown as Promise<{ data: any[] | null; error: any }>);
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
