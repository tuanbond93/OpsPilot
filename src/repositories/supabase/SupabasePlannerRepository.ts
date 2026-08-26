import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PlannerRunRow,
  PlannerReviewEventRow,
  PlannerRunStatus,
} from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import { serializePromptVersion } from "@/repositories/planner/prompt-version-mapper";
import type { IPlannerRepository } from "../interfaces/IPlannerRepository";

export class SupabasePlannerRepository extends BaseRepository implements IPlannerRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async createPlannerRun(run: Partial<PlannerRunRow>): Promise<PlannerRunRow> {
    const nowIso = new Date().toISOString();
    const newRun: Partial<PlannerRunRow> = {
      incident_id: run.incident_id,
      followup_case_id: run.followup_case_id || null,
      status: run.status || "DRAFT",
      context_hash: run.context_hash || "",
      prompt_version: run.prompt_version ? serializePromptVersion(run.prompt_version as any) : 1,
      provider: run.provider || "deterministic_fallback",
      model: run.model || "none",
      result: run.result || {},
      created_at: run.created_at || nowIso,
      reviewed_at: run.reviewed_at || null,
      reviewed_by: run.reviewed_by || null,
    };

    const { data, error } = await this.client
      .from("planner_runs")
      .insert([newRun])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") { // Unique constraint violation on active DRAFT run
        const existingDraft = await this.getPlannerRunByContextHashAndVersion(
          newRun.incident_id!,
          newRun.context_hash!,
          newRun.prompt_version!,
          "DRAFT"
        );
        if (existingDraft) return existingDraft;
      }
      throw error;
    }

    if (!data) {
      throw new Error("No data returned from createPlannerRun insertion");
    }

    // Return raw numeric prompt_version as is (no deserialization)
    return data;
  }

  async getPlannerRunById(id: string): Promise<PlannerRunRow | null> {
    const query = this.client
      .from("planner_runs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    const row = await this.executeOptional<PlannerRunRow>(query as any);
    return row;
  }

  async getPlannerRunByContextHashAndVersion(
    incidentId: string,
    contextHash: string,
    promptVersion: number,
    status?: PlannerRunStatus
  ): Promise<PlannerRunRow | null> {
    let query = this.client
      .from("planner_runs")
      .select("*")
      .eq("incident_id", incidentId)
      .eq("context_hash", contextHash)
      .eq("prompt_version", promptVersion);

    if (status) {
      query = query.eq("status", status);
    }

    const finalQuery = query
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = await this.executeOptional<PlannerRunRow>(finalQuery as any);
    if (row) {
    }
    return row;
  }

  async updatePlannerRunStatus(
    id: string,
    status: PlannerRunStatus,
    reviewedBy?: string,
    reviewedAt: string = new Date().toISOString()
  ): Promise<PlannerRunRow | null> {
    const query = this.client
      .from("planner_runs")
      .update({
        status,
        reviewed_by: reviewedBy || null,
        reviewed_at: reviewedAt,
      })
      .eq("id", id)
      .select()
      .maybeSingle();

    const row = await this.executeOptional<PlannerRunRow>(query as any);
    if (row) {

    }
    return row;
  }

  async getAllPlannerRuns(incidentId?: string, limit: number = 50): Promise<PlannerRunRow[]> {
    let query = this.client.from("planner_runs").select("*");

    if (incidentId) {
      query = query.eq("incident_id", incidentId);
    }

    const finalQuery = query
      .order("created_at", { ascending: false })
      .limit(limit);

    const rows = await this.executeMany<PlannerRunRow>(finalQuery as any);
    return rows;
  }

  async getLatestPlannerRunByIncidentId(incidentId: string): Promise<PlannerRunRow | null> {
    const runs = await this.getAllPlannerRuns(incidentId, 1);
    return runs[0] || null;
  }

  async insertReviewEvent(event: Partial<PlannerReviewEventRow>): Promise<PlannerReviewEventRow> {
    const nowIso = new Date().toISOString();
    const newEvent: Partial<PlannerReviewEventRow> = {
      planner_run_id: event.planner_run_id,
      event_type: event.event_type || "CREATED",
      actor: event.actor || "system",
      note: event.note || null,
      created_at: event.created_at || nowIso,
    };

    const query = this.client
      .from("planner_review_events")
      .insert([newEvent])
      .select()
      .single();

    return this.executeSingle<PlannerReviewEventRow>(query as any);
  }

  async getReviewEventsByRunId(plannerRunId: string): Promise<PlannerReviewEventRow[]> {
    const query = this.client
      .from("planner_review_events")
      .select("*")
      .eq("planner_run_id", plannerRunId)
      .order("created_at", { ascending: true });

    return this.executeMany<PlannerReviewEventRow>(query as any);
  }

  async getRecentReviewEvents(limit: number = 30): Promise<PlannerReviewEventRow[]> {
    const query = this.client
      .from("planner_review_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<PlannerReviewEventRow>(query as any);
  }
}
