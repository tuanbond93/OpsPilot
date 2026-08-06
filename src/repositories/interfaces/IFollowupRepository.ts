import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";

export interface IFollowupRepository {
  getCaseById(id: string): Promise<FollowupCaseRow | null>;
  getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]>;
  getAllCases(): Promise<FollowupCaseRow[]>;
  upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow>;
  insertEvent(eventData: Partial<FollowupEventRow> & { followup_case_id: string }): Promise<FollowupEventRow>;
  getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]>;
  getRecentEvents(limit?: number): Promise<FollowupEventRow[]>;
}
