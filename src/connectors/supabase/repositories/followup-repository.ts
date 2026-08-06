import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "../types";
import { isFallbackAllowed } from "../fallback-policy";

export class FollowupRepository {
  private inMemoryCases: FollowupCaseRow[] = [];
  private inMemoryEvents: FollowupEventRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryCases = [];
    this.inMemoryEvents = [];
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_cases")
          .select("*")
          .or(`id.eq.${id},incident_key.eq.${id}`)
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryCases.find((c) => c.id === id || c.incident_key === id) || null;
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    if (incidentKeys.length === 0) return [];

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_cases")
          .select("*")
          .in("incident_key", incidentKeys);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getCasesByIncidentKeys failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryCases.filter((c) => incidentKeys.includes(c.incident_key));
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_cases")
          .select("*")
          .order("updated_at", { ascending: false });

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getAllCases DB query failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryCases].sort(
      (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    );
  }

  async upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    const payload = {
      ...caseData,
      updated_at: now,
    };

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_cases")
          .upsert(payload, { onConflict: "incident_id" })
          .select()
          .single();

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("upsertCase DB call failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const existingIndex = this.inMemoryCases.findIndex((c) => c.incident_id === caseData.incident_id);
    const fullRow: FollowupCaseRow = {
      id: caseData.id || `fcase-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      incident_id: caseData.incident_id,
      incident_key: caseData.incident_key,
      first_detected_at: caseData.first_detected_at || now,
      baseline_affected_order_count: caseData.baseline_affected_order_count || 0,
      latest_affected_order_count: caseData.latest_affected_order_count || 0,
      current_state: caseData.current_state || "NEW",
      current_progress_percent: caseData.current_progress_percent || 0,
      current_assessment: caseData.current_assessment || "insufficient_data",
      last_checked_at: caseData.last_checked_at || now,
      next_action_at: caseData.next_action_at || null,
      last_action_requested_at: caseData.last_action_requested_at || null,
      last_action_confirmed_at: caseData.last_action_confirmed_at || null,
      resolved_at: caseData.resolved_at || null,
      created_at: caseData.created_at || now,
      updated_at: now,
    };

    if (existingIndex >= 0) {
      this.inMemoryCases[existingIndex] = { ...this.inMemoryCases[existingIndex], ...fullRow };
      return this.inMemoryCases[existingIndex];
    } else {
      this.inMemoryCases.push(fullRow);
      return fullRow;
    }
  }

  async insertEvent(eventData: Partial<FollowupEventRow> & { followup_case_id: string }): Promise<FollowupEventRow> {
    const now = new Date().toISOString();
    const payload = {
      ...eventData,
      event_time: eventData.event_time || now,
      created_at: eventData.created_at || now,
    };

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_events")
          .insert([payload])
          .select()
          .single();

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("insertEvent DB call failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const fullRow: FollowupEventRow = {
      id: eventData.id || `fevt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      followup_case_id: eventData.followup_case_id,
      event_type: eventData.event_type || "CASE_CREATED",
      event_time: eventData.event_time || now,
      snapshot_id: eventData.snapshot_id || null,
      old_state: eventData.old_state || "NEW",
      new_state: eventData.new_state || "NEW",
      assessment: eventData.assessment || "insufficient_data",
      confirmed_by: eventData.confirmed_by || null,
      notes: eventData.notes || null,
      created_at: now,
    };

    this.inMemoryEvents.push(fullRow);
    return fullRow;
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_events")
          .select("*")
          .eq("followup_case_id", followupCaseId)
          .order("created_at", { ascending: false });

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getEventsByCaseId failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryEvents
      .filter((e) => e.followup_case_id === followupCaseId)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("followup_events")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getRecentEvents failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryEvents]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
