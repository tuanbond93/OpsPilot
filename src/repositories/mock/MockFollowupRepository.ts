import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import type {
  FollowupCaseUpsert,
  FollowupEventInsert,
  FollowupEventEvidence,
  IFollowupRepository,
  FollowupCasePageCursor,
  FollowupCohortGenerationOptions,
  FollowupCaseCohortReference,
} from "../interfaces/IFollowupRepository";
import {
  assertFollowupMemberGenerationParity,
  hydrateOperationalCohortV2,
  isOperationalCohortV2Metadata,
  operationalCohortMemberRows,
  operationalCohortV2Metadata,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";

export class MockFollowupRepository implements IFollowupRepository {
  private inMemoryCases: FollowupCaseRow[] = [];
  private inMemoryEvents: FollowupEventRow[] = [];
  private inMemoryMembers: FollowupCaseMemberRow[] = [];
  private nextCaseId = 1;
  private nextEventId = 1;

  clearMemory(): void {
    this.inMemoryCases = [];
    this.inMemoryEvents = [];
    this.inMemoryMembers = [];
    this.nextCaseId = 1;
    this.nextEventId = 1;
  }

  seed(cases: FollowupCaseRow[], events: FollowupEventRow[]): void {
    this.inMemoryCases = [...cases];
    this.inMemoryEvents = [...events];
    this.inMemoryMembers = [];
  }

  private hydrateCase(row: FollowupCaseRow): FollowupCaseRow {
    const metadata = row.operational_cohort as unknown;
    if (row.cohort_version === 2 || isOperationalCohortV2Metadata(metadata)) {
      if (!isOperationalCohortV2Metadata(metadata) || !row.member_generation_id) {
        throw new Error(`FOLLOWUP_COHORT_V2_POINTER_MISSING:${row.id}`);
      }
      const members = this.inMemoryMembers.filter((member) => member.followup_case_id === row.id && member.generation_id === row.member_generation_id);
      return { ...row, operational_cohort: hydrateOperationalCohortV2(metadata, members, { followupCaseId: row.id, generationId: row.member_generation_id }) };
    }
    return { ...row };
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    const found = this.inMemoryCases.find((c) => c.id === id || c.incident_key === id);
    return found ? this.hydrateCase(found) : null;
  }

  async hydrateFollowupCaseCohorts<T extends FollowupCaseCohortReference>(cases: T[]): Promise<Array<T & { operational_cohort?: OperationalCohort | null }>> {
    return cases.map((row) => {
      const metadata = row.operational_cohort;
      if (row.cohort_version === 2 || isOperationalCohortV2Metadata(metadata)) {
        if (!row.member_generation_id || !isOperationalCohortV2Metadata(metadata)) {
          throw new Error(`FOLLOWUP_COHORT_V2_POINTER_MISSING:${row.id}`);
        }
        const members = this.inMemoryMembers.filter((member) => member.followup_case_id === row.id && member.generation_id === row.member_generation_id);
        return { ...row, operational_cohort: hydrateOperationalCohortV2(metadata, members, { followupCaseId: row.id, generationId: row.member_generation_id }) };
      }
      return { ...row };
    }) as Array<T & { operational_cohort?: OperationalCohort | null }>;
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    return this.inMemoryCases.filter((c) => incidentKeys.includes(c.incident_key)).map((row) => this.hydrateCase(row));
  }

  async getOperationalCasesPage(cursor?: FollowupCasePageCursor, limit: number = 100): Promise<{
    cases: FollowupCaseRow[];
    nextCursor: FollowupCasePageCursor | null;
  }> {
    const eligible = [...this.inMemoryCases]
      .filter((item) => item.current_state !== "CLOSED")
      .sort((a, b) => {
        const updatedAtDifference = new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
        return updatedAtDifference || b.id.localeCompare(a.id);
      });
    const startIndex = cursor
      ? Math.max(0, eligible.findIndex((item) => item.id === cursor.id) + 1)
      : 0;
    const cases = eligible.slice(startIndex, startIndex + limit);
    const last = cases[cases.length - 1];
    return {
      cases: cases.map((row) => this.hydrateCase(row)),
      nextCursor: cases.length === limit && last?.updated_at
        ? { updatedAt: last.updated_at, id: last.id }
        : null,
    };
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    return [...this.inMemoryCases].sort(
      (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    ).map((row) => this.hydrateCase(row));
  }

  async upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    // Mirrors the production upsert conflict target: incident_key is the
    // composite business identity, while incident_id is the persisted UUID FK.
    const existingIndex = this.inMemoryCases.findIndex((c) => c.incident_key === caseData.incident_key);

    const fullRow: FollowupCaseRow = {
      ...(caseData.operational_cohort !== undefined ? { operational_cohort: caseData.operational_cohort } : {}),
      ...(caseData.cohort_version !== undefined ? { cohort_version: caseData.cohort_version } : {}),
      ...(caseData.member_generation_id !== undefined ? { member_generation_id: caseData.member_generation_id } : {}),
      id: caseData.id || `fcase-${this.nextCaseId++}`,
      incident_id: caseData.incident_id,
      incident_key: caseData.incident_key,
      first_detected_at: caseData.first_detected_at || now,
      baseline_affected_order_count: caseData.baseline_affected_order_count || 0,
      latest_affected_order_count: caseData.latest_affected_order_count || 0,
      current_state: caseData.current_state || "NEW",
      current_progress_percent: caseData.current_progress_percent || 0,
      current_assessment: caseData.current_assessment || "insufficient_data",
      current_rillnet_status_signature: caseData.current_rillnet_status_signature || "",
      ...(caseData.last_action_rillnet_status_signature !== undefined ? { last_action_rillnet_status_signature: caseData.last_action_rillnet_status_signature } : {}),
      ...(caseData.rillnet_change_summary !== undefined ? { rillnet_change_summary: caseData.rillnet_change_summary } : {}),
      ...(caseData.rillnet_changed_at !== undefined ? { rillnet_changed_at: caseData.rillnet_changed_at } : {}),
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

  async batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseRow[]> {
    const results: FollowupCaseRow[] = [];
    for (const caseData of cases) {
      results.push(await this.upsertCase(caseData));
    }
    return results;
  }

  async persistOperationalCohortGenerations(cases: FollowupCaseUpsert[], generationId: string, options: FollowupCohortGenerationOptions = {}): Promise<FollowupCaseRow[]> {
    const persisted: FollowupCaseRow[] = [];
    for (const caseData of cases) {
      const cohort = caseData.operational_cohort as OperationalCohort | null | undefined;
      if (!cohort) throw new Error(`FOLLOWUP_COHORT_V1_INPUT_REQUIRED:${caseData.incident_key}`);
      const row = await this.upsertCase(caseData);
      const sourceSyncRunId = options.sourceSyncRunId === undefined ? generationId : options.sourceSyncRunId;
      const expectedMembers = operationalCohortMemberRows(row.id, generationId, sourceSyncRunId, cohort);
      const expectedByKey = new Map(expectedMembers.map((member) => [`${member.followup_case_id}:${member.generation_id}:${member.order_code}`, member]));
      this.inMemoryMembers = this.inMemoryMembers.filter((member) => !expectedByKey.has(`${member.followup_case_id}:${member.generation_id}:${member.order_code}`));
      this.inMemoryMembers.push(...expectedMembers);
      assertFollowupMemberGenerationParity(expectedMembers, this.inMemoryMembers.filter((member) => member.followup_case_id === row.id && member.generation_id === generationId));
      const metadata = operationalCohortV2Metadata(cohort);
      const internal = this.inMemoryCases.find((candidate) => candidate.id === row.id)!;
      internal.operational_cohort = metadata as unknown as OperationalCohort;
      internal.cohort_version = 2;
      internal.member_generation_id = generationId;
      internal.updated_at = new Date().toISOString();
      persisted.push({ id: internal.id, incident_id: internal.incident_id, incident_key: internal.incident_key } as FollowupCaseRow);
    }
    return persisted;
  }

  async insertEvent(eventData: FollowupEventInsert): Promise<FollowupEventRow> {
    const now = new Date().toISOString();
    const fullRow: FollowupEventRow = {
      id: eventData.id || `fevt-${this.nextEventId++}`,
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

  async batchInsertEvents(events: FollowupEventInsert[]): Promise<FollowupEventRow[]> {
    const results: FollowupEventRow[] = [];
    for (const eventData of events) {
      results.push(await this.insertEvent(eventData));
    }
    return results;
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    return this.inMemoryEvents
      .filter((e) => e.followup_case_id === followupCaseId)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  async getEventsByCaseIds(followupCaseIds: string[]): Promise<FollowupEventEvidence[]> {
    const ids = new Set(followupCaseIds.filter(Boolean));
    return this.inMemoryEvents
      .filter((event) => ids.has(event.followup_case_id))
      .map(({ followup_case_id, event_type, new_state }) => ({ followup_case_id, event_type, new_state }));
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    return [...this.inMemoryEvents]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
