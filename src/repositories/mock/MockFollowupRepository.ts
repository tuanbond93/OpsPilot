import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import type { IFollowupRepository } from "../interfaces/IFollowupRepository";

export class MockFollowupRepository implements IFollowupRepository {
  private inMemoryCases: FollowupCaseRow[] = [];
  private inMemoryEvents: FollowupEventRow[] = [];

  clearMemory(): void {
    this.inMemoryCases = [];
    this.inMemoryEvents = [];
  }

  seed(cases: FollowupCaseRow[], events: FollowupEventRow[]): void {
    this.inMemoryCases = [...cases];
    this.inMemoryEvents = [...events];
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    return this.inMemoryCases.find((c) => c.id === id || c.incident_key === id) || null;
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    return this.inMemoryCases.filter((c) => incidentKeys.includes(c.incident_key));
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    return [...this.inMemoryCases].sort(
      (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    );
  }

  async upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
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
    return this.inMemoryEvents
      .filter((e) => e.followup_case_id === followupCaseId)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    return [...this.inMemoryEvents]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
