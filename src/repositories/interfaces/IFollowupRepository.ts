import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";

export type FollowupCaseUpsert = Partial<FollowupCaseRow> & {
  incident_id: string;
  incident_key: string;
};

export type FollowupEventInsert = Partial<FollowupEventRow> & {
  followup_case_id: string;
};

export interface IFollowupRepository {
  getCaseById(id: string): Promise<FollowupCaseRow | null>;
  getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]>;
  getAllCases(): Promise<FollowupCaseRow[]>;
  upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow>;
  batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseRow[]>;
  insertEvent(eventData: FollowupEventInsert): Promise<FollowupEventRow>;
  batchInsertEvents(events: FollowupEventInsert[]): Promise<FollowupEventRow[]>;
  getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]>;
  getRecentEvents(limit?: number): Promise<FollowupEventRow[]>;
}
