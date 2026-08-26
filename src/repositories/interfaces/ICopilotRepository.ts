// src/repositories/interfaces/ICopilotRepository.ts

import type { CopilotRunRow, CopilotReviewRow } from "@/connectors/supabase/types";

export interface ICopilotRepository {
  createCopilotRun(run: Partial<CopilotRunRow>): Promise<CopilotRunRow>;
  getLatestCopilotRunByIncidentId(incidentId: string): Promise<CopilotRunRow | null>;
  getCopilotRunById(id: string): Promise<CopilotRunRow | null>;
  listRecentCopilotRuns(limit?: number): Promise<CopilotRunRow[]>;
  createReview(review: Partial<CopilotReviewRow>): Promise<CopilotReviewRow>;
  getActiveReviewByRunId(runId: string): Promise<CopilotReviewRow | null>;
  getActiveReviewByIncidentId(incidentId: string): Promise<CopilotReviewRow | null>;
  listReviewsByRunId(runId: string): Promise<CopilotReviewRow[]>;
  listReviewsByIncidentId(incidentId: string): Promise<CopilotReviewRow[]>;
  getAllReviews(limit?: number): Promise<CopilotReviewRow[]>;
}
