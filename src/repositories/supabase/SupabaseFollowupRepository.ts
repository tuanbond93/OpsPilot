import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type { IFollowupRepository } from "../interfaces/IFollowupRepository";

export class SupabaseFollowupRepository extends BaseRepository implements IFollowupRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    const query = this.client
      .from("followup_cases")
      .select("*")
      .or(`id.eq.${id},incident_key.eq.${id}`)
      .maybeSingle();

    return this.executeOptional<FollowupCaseRow>(query as any);
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    if (incidentKeys.length === 0) return [];

    const query = this.client
      .from("followup_cases")
      .select("*")
      .in("incident_key", incidentKeys);

    return this.executeMany<FollowupCaseRow>(query as any);
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    const query = this.client
      .from("followup_cases")
      .select("*")
      .order("updated_at", { ascending: false });

    return this.executeMany<FollowupCaseRow>(query as any);
  }

  async upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    const payload = {
      ...caseData,
      updated_at: now,
    };

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_id" })
      .select()
      .single();

    return this.executeSingle<FollowupCaseRow>(query as any);
  }

  async insertEvent(eventData: Partial<FollowupEventRow> & { followup_case_id: string }): Promise<FollowupEventRow> {
    const now = new Date().toISOString();
    const payload = {
      ...eventData,
      event_time: eventData.event_time || now,
      created_at: eventData.created_at || now,
    };

    const query = this.client
      .from("followup_events")
      .insert([payload])
      .select()
      .single();

    return this.executeSingle<FollowupEventRow>(query as any);
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .eq("followup_case_id", followupCaseId)
      .order("created_at", { ascending: false });

    return this.executeMany<FollowupEventRow>(query as any);
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<FollowupEventRow>(query as any);
  }
}
