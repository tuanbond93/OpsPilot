import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";

export type FollowupCasePageCursor = {
  updatedAt: string;
  id: string;
};

export type FollowupCaseUpsert = Partial<FollowupCaseRow> & {
  incident_id: string;
  incident_key: string;
};

export type FollowupEventInsert = Partial<FollowupEventRow> & {
  followup_case_id: string;
};

export type FollowupCaseLinkRow = Pick<FollowupCaseRow, "id" | "incident_id" | "incident_key">;
export type FollowupEventEvidence = Pick<FollowupEventRow, "followup_case_id" | "event_type" | "new_state">;
export type FollowupCohortGenerationOptions = {
  sourceSyncRunId?: string | null;
  archiveLegacy?: boolean;
};
export type FollowupCaseCohortReference = {
  id: string;
  operational_cohort?: unknown;
  cohort_version?: number | null;
  member_generation_id?: string | null;
};

export interface IFollowupRepository {
  getCaseById(id: string): Promise<FollowupCaseRow | null>;
  hydrateFollowupCaseCohorts<T extends FollowupCaseCohortReference>(cases: T[]): Promise<Array<T & { operational_cohort?: OperationalCohort | null }>>;
  getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]>;
  getOperationalCasesPage(cursor?: FollowupCasePageCursor, limit?: number): Promise<{
    cases: FollowupCaseRow[];
    nextCursor: FollowupCasePageCursor | null;
  }>;
  getAllCases(): Promise<FollowupCaseRow[]>;
  getAllCasesSummary?(): Promise<FollowupCaseRow[]>;
  upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow>;
  batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseLinkRow[]>;
  persistOperationalCohortGenerations(cases: FollowupCaseUpsert[], generationId: string, options?: FollowupCohortGenerationOptions): Promise<FollowupCaseLinkRow[]>;
  insertEvent(eventData: FollowupEventInsert): Promise<FollowupEventRow>;
  batchInsertEvents(events: FollowupEventInsert[]): Promise<FollowupEventRow[]>;
  getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]>;
  getEventsByCaseIds?(followupCaseIds: string[]): Promise<FollowupEventEvidence[]>;
  getRecentEvents(limit?: number): Promise<FollowupEventRow[]>;
}
