import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type {
  FollowupCaseUpsert,
  FollowupEventInsert,
  IFollowupRepository,
} from "../interfaces/IFollowupRepository";

const FOLLOWUP_CASE_COLUMNS = [
  "id",
  "incident_id",
  "incident_key",
  "current_state",
  "first_detected_at",
  "last_checked_at",
  "next_action_at",
  "last_action_requested_at",
  "last_action_confirmed_at",
  "resolved_at",
  "closed_at",
  "baseline_affected_order_count",
  "latest_affected_order_count",
  "current_progress_percent",
  "current_assessment",
  "created_at",
  "updated_at",
].join(", ");

const FOLLOWUP_EVENT_COLUMNS = [
  "id",
  "followup_case_id",
  "event_type",
  "event_time",
  "snapshot_id",
  "old_state",
  "new_state",
  "assessment",
  "confirmed_by",
  "notes",
  "created_at",
].join(", ");

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
      .select(FOLLOWUP_CASE_COLUMNS)
      .in("incident_key", incidentKeys);

    return this.executeMany<FollowupCaseRow>(query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>);
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    const query = this.client
      .from("followup_cases")
      .select("*")
      .order("updated_at", { ascending: false });

    return this.executeMany<FollowupCaseRow>(query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>);
  }

  async upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow> {
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

  async batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseRow[]> {
    if (cases.length === 0) return [];

    const now = new Date().toISOString();
    const payload = cases.map((caseData) => ({
      ...caseData,
      updated_at: now,
    }));

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_id" })
      .select(FOLLOWUP_CASE_COLUMNS);

    return this.executeMany<FollowupCaseRow>(query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>);
  }

  async insertEvent(eventData: FollowupEventInsert): Promise<FollowupEventRow> {
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

  async batchInsertEvents(events: FollowupEventInsert[]): Promise<FollowupEventRow[]> {
    if (events.length === 0) return [];

    const now = new Date().toISOString();
    const payload = events.map((eventData) => ({
      ...eventData,
      event_time: eventData.event_time || now,
      created_at: eventData.created_at || now,
    }));

    const query = this.client
      .from("followup_events")
      .insert(payload)
      .select(FOLLOWUP_EVENT_COLUMNS);

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .eq("followup_case_id", followupCaseId)
      .order("created_at", { ascending: false });

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }
}
