import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "../types";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export class FollowupRepository {
  constructor(private client?: SupabaseClient | null) {
    // Preserves signature. If a custom client is explicitly supplied,
    // the RepositoryFactory resolves a dedicated SupabaseFollowupRepository using it.
  }

  clearMemory(): void {
    const repo = RepositoryFactory.getFollowupRepository(this.client);
    if (repo && typeof (repo as any).clearMemory === "function") {
      (repo as any).clearMemory();
    }
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    return RepositoryFactory.getFollowupRepository(this.client).getCaseById(id);
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    return RepositoryFactory.getFollowupRepository(this.client).getCasesByIncidentKeys(incidentKeys);
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    return RepositoryFactory.getFollowupRepository(this.client).getAllCases();
  }

  async upsertCase(caseData: Partial<FollowupCaseRow> & { incident_id: string; incident_key: string }): Promise<FollowupCaseRow> {
    return RepositoryFactory.getFollowupRepository(this.client).upsertCase(caseData);
  }

  async insertEvent(eventData: Partial<FollowupEventRow> & { followup_case_id: string }): Promise<FollowupEventRow> {
    return RepositoryFactory.getFollowupRepository(this.client).insertEvent(eventData);
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    return RepositoryFactory.getFollowupRepository(this.client).getEventsByCaseId(followupCaseId);
  }

  async getRecentEvents(limit?: number): Promise<FollowupEventRow[]> {
    return RepositoryFactory.getFollowupRepository(this.client).getRecentEvents(limit);
  }
}
