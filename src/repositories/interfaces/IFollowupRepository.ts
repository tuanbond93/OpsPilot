import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";

export interface IFollowupRepository {
  getCaseByIncidentId(incidentId: string): Promise<FollowupCaseRow | null>;
  upsertCase(caseData: Partial<FollowupCaseRow>): Promise<FollowupCaseRow>;
  appendTransitionEvent(event: Omit<FollowupEventRow, "id" | "created_at">): Promise<FollowupEventRow>;
  getRecentEvents(limit?: number): Promise<FollowupEventRow[]>;
}
