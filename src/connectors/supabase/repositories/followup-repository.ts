import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "../types";

export class FollowupRepository {
  constructor(private client: SupabaseClient) {}

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    const { data, error } = await this.client
      .from("followup_cases")
      .select("*")
      .or(`id.eq.${id},incident_key.eq.${id}`)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to fetch followup_case for id/key '${id}': ${error.message}`);
    }

    return data;
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    if (incidentKeys.length === 0) return [];

    const { data, error } = await this.client
      .from("followup_cases")
      .select("*")
      .in("incident_key", incidentKeys);

    if (error) {
      throw new Error(`Failed to batch fetch followup_cases: ${error.message}`);
    }

    return data || [];
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    const { data, error } = await this.client
      .from("followup_cases")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch all followup_cases: ${error.message}`);
    }

    return data || [];
  }

  async upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    const payload = {
      ...caseData,
      updated_at: now,
    };

    const { data, error } = await this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_id" })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to upsert followup_case: ${error.message}`);
    }

    return data;
  }

  async upsertCasesBatch(
    casesData: Array<Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }>
  ): Promise<FollowupCaseRow[]> {
    if (casesData.length === 0) return [];

    const now = new Date().toISOString();
    const payload = casesData.map((c) => ({
      ...c,
      updated_at: now,
    }));

    const { data, error } = await this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_id" })
      .select();

    if (error) {
      throw new Error(`Failed to batch upsert followup_cases: ${error.message}`);
    }

    return data || [];
  }

  async insertEvent(eventData: Omit<FollowupEventRow, "id" | "created_at">): Promise<FollowupEventRow> {
    const { data, error } = await this.client
      .from("followup_events")
      .insert([eventData])
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to insert followup_event: ${error.message}`);
    }

    return data;
  }

  async insertEventsBatch(
    eventsData: Array<Omit<FollowupEventRow, "id" | "created_at">>
  ): Promise<FollowupEventRow[]> {
    if (eventsData.length === 0) return [];

    const { data, error } = await this.client
      .from("followup_events")
      .insert(eventsData)
      .select();

    if (error) {
      throw new Error(`Failed to batch insert followup_events: ${error.message}`);
    }

    return data || [];
  }

  async getEventsByCaseId(caseId: string): Promise<FollowupEventRow[]> {
    const { data, error } = await this.client
      .from("followup_events")
      .select("*")
      .eq("followup_case_id", caseId)
      .order("event_time", { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch followup_events: ${error.message}`);
    }

    return data || [];
  }
}
