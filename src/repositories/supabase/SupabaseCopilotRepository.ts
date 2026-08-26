// src/repositories/supabase/SupabaseCopilotRepository.ts

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CopilotRunRow, CopilotReviewRow } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type { ICopilotRepository } from "../interfaces/ICopilotRepository";

export class SupabaseCopilotRepository extends BaseRepository implements ICopilotRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async createCopilotRun(run: Partial<CopilotRunRow>): Promise<CopilotRunRow> {
    const nowIso = new Date().toISOString();
    const newRun: Partial<CopilotRunRow> = {
      incident_id: run.incident_id,
      workflow_id: run.workflow_id,
      prompt_id: run.prompt_id || "copilot",
      prompt_version: run.prompt_version || "v1",
      provider: run.provider || "openai",
      model: run.model || "default",
      copilot_result: run.copilot_result || {},
      created_at: run.created_at || nowIso,
      updated_at: run.updated_at || nowIso,
    };

    const query = this.client
      .from("copilot_runs")
      .insert([newRun])
      .select()
      .single();

    return this.executeSingle<CopilotRunRow>(query as any);
  }

  async getLatestCopilotRunByIncidentId(incidentId: string): Promise<CopilotRunRow | null> {
    const query = this.client
      .from("copilot_runs")
      .select("*")
      .eq("incident_id", incidentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<CopilotRunRow>(query as any);
  }

  async getCopilotRunById(id: string): Promise<CopilotRunRow | null> {
    const query = this.client
      .from("copilot_runs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    return this.executeOptional<CopilotRunRow>(query as any);
  }

  async listRecentCopilotRuns(limit: number = 100): Promise<CopilotRunRow[]> {
    const query = this.client
      .from("copilot_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<CopilotRunRow>(query as any);
  }

  async createReview(review: Partial<CopilotReviewRow>): Promise<CopilotReviewRow> {
    const nowIso = new Date().toISOString();
    const runId = review.run_id!;

    // 1. Mark previous active review for run_id as SUPERSEDED and is_active = false
    await this.client
      .from("copilot_reviews")
      .update({ is_active: false, status: "SUPERSEDED" })
      .eq("run_id", runId)
      .eq("is_active", true);

    // 2. Insert new active review
    const newReview: Partial<CopilotReviewRow> = {
      run_id: runId,
      incident_id: review.incident_id!,
      workflow_id: review.workflow_id!,
      status: review.status || "PENDING",
      is_active: review.is_active !== undefined ? review.is_active : true,
      reviewed_by: review.reviewed_by || null,
      rating: review.rating ?? null,
      comment: review.comment || null,
      edited_result: review.edited_result || null,
      prompt_id: review.prompt_id || "copilot",
      prompt_version: review.prompt_version || "v1",
      provider: review.provider || null,
      model: review.model || null,
      reviewed_at: review.reviewed_at || nowIso,
      created_at: review.created_at || nowIso,
    };

    const query = this.client
      .from("copilot_reviews")
      .insert([newReview])
      .select()
      .single();

    return this.executeSingle<CopilotReviewRow>(query as any);
  }

  async getActiveReviewByRunId(runId: string): Promise<CopilotReviewRow | null> {
    const query = this.client
      .from("copilot_reviews")
      .select("*")
      .eq("run_id", runId)
      .eq("is_active", true)
      .maybeSingle();

    return this.executeOptional<CopilotReviewRow>(query as any);
  }

  async getActiveReviewByIncidentId(incidentId: string): Promise<CopilotReviewRow | null> {
    const query = this.client
      .from("copilot_reviews")
      .select("*")
      .eq("incident_id", incidentId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<CopilotReviewRow>(query as any);
  }

  async listReviewsByRunId(runId: string): Promise<CopilotReviewRow[]> {
    const query = this.client
      .from("copilot_reviews")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false });

    return this.executeMany<CopilotReviewRow>(query as any);
  }

  async listReviewsByIncidentId(incidentId: string): Promise<CopilotReviewRow[]> {
    const query = this.client
      .from("copilot_reviews")
      .select("*")
      .eq("incident_id", incidentId)
      .order("created_at", { ascending: false });

    return this.executeMany<CopilotReviewRow>(query as any);
  }

  async getAllReviews(limit: number = 100): Promise<CopilotReviewRow[]> {
    const query = this.client
      .from("copilot_reviews")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<CopilotReviewRow>(query as any);
  }
}
