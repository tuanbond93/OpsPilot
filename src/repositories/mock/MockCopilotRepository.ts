// src/repositories/mock/MockCopilotRepository.ts

import type { CopilotRunRow, CopilotReviewRow } from "@/connectors/supabase/types";
import type { ICopilotRepository } from "../interfaces/ICopilotRepository";

export class MockCopilotRepository implements ICopilotRepository {
  private inMemoryRuns: CopilotRunRow[] = [];
  private inMemoryReviews: CopilotReviewRow[] = [];

  clearMemory(): void {
    this.inMemoryRuns = [];
    this.inMemoryReviews = [];
  }

  seed(runs: CopilotRunRow[], reviews: CopilotReviewRow[]): void {
    this.inMemoryRuns = [...runs];
    this.inMemoryReviews = [...reviews];
  }

  async createCopilotRun(run: Partial<CopilotRunRow>): Promise<CopilotRunRow> {
    const nowIso = new Date().toISOString();
    const id = run.id || `crun-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRow: CopilotRunRow = {
      id,
      incident_id: run.incident_id!,
      workflow_id: run.workflow_id!,
      prompt_id: run.prompt_id || "copilot",
      prompt_version: run.prompt_version || "v1",
      provider: run.provider || "openai",
      model: run.model || "default",
      copilot_result: run.copilot_result || {},
      created_at: run.created_at || nowIso,
      updated_at: run.updated_at || nowIso,
    };
    this.inMemoryRuns.push(fullRow);
    return fullRow;
  }

  async getLatestCopilotRunByIncidentId(incidentId: string): Promise<CopilotRunRow | null> {
    const matches = this.inMemoryRuns.filter((r) => r.incident_id === incidentId);
    return (
      matches.sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      )[0] || null
    );
  }

  async getCopilotRunById(id: string): Promise<CopilotRunRow | null> {
    return this.inMemoryRuns.find((r) => r.id === id) || null;
  }

  async listRecentCopilotRuns(limit: number = 100): Promise<CopilotRunRow[]> {
    return [...this.inMemoryRuns]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }

  async createReview(review: Partial<CopilotReviewRow>): Promise<CopilotReviewRow> {
    const nowIso = new Date().toISOString();
    const runId = review.run_id!;

    // Atomic transaction simulation: mark previous active review for run_id as SUPERSEDED and is_active = false
    this.inMemoryReviews.forEach((r) => {
      if (r.run_id === runId && r.is_active) {
        r.is_active = false;
        r.status = "SUPERSEDED";
      }
    });

    const id = review.id || `crev-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRow: CopilotReviewRow = {
      id,
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

    this.inMemoryReviews.push(fullRow);
    return fullRow;
  }

  async getActiveReviewByRunId(runId: string): Promise<CopilotReviewRow | null> {
    return (
      this.inMemoryReviews.find((r) => r.run_id === runId && r.is_active) || null
    );
  }

  async getActiveReviewByIncidentId(incidentId: string): Promise<CopilotReviewRow | null> {
    const reviews = this.inMemoryReviews.filter((r) => r.incident_id === incidentId && r.is_active);
    return (
      reviews.sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      )[0] || null
    );
  }

  async listReviewsByRunId(runId: string): Promise<CopilotReviewRow[]> {
    return this.inMemoryReviews
      .filter((r) => r.run_id === runId)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  async listReviewsByIncidentId(incidentId: string): Promise<CopilotReviewRow[]> {
    return this.inMemoryReviews
      .filter((r) => r.incident_id === incidentId)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  async getAllReviews(limit: number = 100): Promise<CopilotReviewRow[]> {
    return [...this.inMemoryReviews]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
