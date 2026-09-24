import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type {
  FollowupCaseUpsert,
  FollowupCaseLinkRow,
  FollowupEventInsert,
  FollowupEventEvidence,
  IFollowupRepository,
  FollowupCasePageCursor,
} from "../interfaces/IFollowupRepository";

const FOLLOWUP_CASE_COLUMNS = [
  "operational_cohort",
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
  "current_rillnet_status_signature",
  "last_action_rillnet_status_signature",
  "rillnet_change_summary",
  "rillnet_changed_at",
  "rillnet_review_before_signature",
  "rillnet_review_after_signature",
  "rillnet_review_detected_at",
  "rillnet_review_snapshot_id",
  "rillnet_review_order_codes",
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

const FOLLOWUP_CASE_PAGE_SIZE = 100;
const FOLLOWUP_EVIDENCE_BATCH_SIZE = 100;
const FOLLOWUP_CASE_LINK_COLUMNS = ["id", "incident_id", "incident_key"].join(", ");
const FOLLOWUP_PROCESSING_CASE_COLUMNS = [
  "operational_cohort",
  "id",
  "incident_id",
  "incident_key",
  "current_state",
  "first_detected_at",
  "last_checked_at",
  "last_action_requested_at",
  "last_action_confirmed_at",
  "resolved_at",
  "baseline_affected_order_count",
  "latest_affected_order_count",
  "current_progress_percent",
  "current_assessment",
  "current_rillnet_status_signature",
  "updated_at",
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

  async getOperationalCasesPage(cursor?: FollowupCasePageCursor, limit: number = FOLLOWUP_CASE_PAGE_SIZE): Promise<{
    cases: FollowupCaseRow[];
    nextCursor: FollowupCasePageCursor | null;
  }> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || FOLLOWUP_CASE_PAGE_SIZE, 1), FOLLOWUP_CASE_PAGE_SIZE);
    const query = this.client
      .from("followup_cases")
      .select(FOLLOWUP_PROCESSING_CASE_COLUMNS)
      .neq("current_state", "CLOSED");

    if (cursor) {
      query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
    }
    query
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(boundedLimit);

    const cases = await this.executeMany<FollowupCaseRow>(
      query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>
    );
    const last = cases[cases.length - 1];

    return {
      cases,
      nextCursor: cases.length === boundedLimit && last?.updated_at
        ? { updatedAt: last.updated_at, id: last.id }
        : null,
    };
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    const cases: FollowupCaseRow[] = [];
    let cursor: FollowupCasePageCursor | undefined;

    // Keep the public repository contract unchanged while ensuring every
    // database statement is bounded. This method serves both the debug/API
    // read path and the follow-up engine, so terminal cases remain included.
    for (;;) {
      const query = this.client
        .from("followup_cases")
        .select(FOLLOWUP_CASE_COLUMNS);

      if (cursor) {
        query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
      }
      query
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(FOLLOWUP_CASE_PAGE_SIZE);

      const page = await this.executeMany<FollowupCaseRow>(
        query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>
      );
      cases.push(...page);

      if (page.length < FOLLOWUP_CASE_PAGE_SIZE) break;
      const last = page[page.length - 1];
      if (!last?.updated_at || !last.id) break;
      cursor = { updatedAt: last.updated_at, id: last.id };
    }

    return cases;
  }

  async upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    const payload = {
      ...caseData,
      updated_at: now,
    };

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_key" })
      .select()
      .single();

    return this.executeSingle<FollowupCaseRow>(query as any);
  }

  async batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseLinkRow[]> {
    if (cases.length === 0) return [];

    const now = new Date().toISOString();
    const payload = cases.map((caseData) => ({
      ...caseData,
      updated_at: now,
    }));

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_key" })
      .select(FOLLOWUP_CASE_LINK_COLUMNS);

    return this.executeMany<FollowupCaseLinkRow>(query as unknown as Promise<{ data: FollowupCaseLinkRow[] | null; error: unknown }>);
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

  async getEventsByCaseIds(followupCaseIds: string[]): Promise<FollowupEventEvidence[]> {
    const ids = Array.from(new Set(followupCaseIds.filter(Boolean)));
    if (ids.length === 0) return [];

    const rows: FollowupEventEvidence[] = [];
    for (let index = 0; index < ids.length; index += FOLLOWUP_EVIDENCE_BATCH_SIZE) {
      const chunk = ids.slice(index, index + FOLLOWUP_EVIDENCE_BATCH_SIZE);
      const query = this.client
        .from("followup_events")
        .select("followup_case_id,event_type,new_state")
        .in("followup_case_id", chunk)
        .or("event_type.eq.PUSH_CONFIRMED,new_state.eq.FIRST_PUSH_SENT");

      rows.push(...await this.executeMany<FollowupEventEvidence>(
        query as unknown as Promise<{ data: FollowupEventEvidence[] | null; error: unknown }>
      ));
    }
    return rows;
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
