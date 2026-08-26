// src/services/interfaces/ICopilotService.ts

import type {
  CopilotRunResult,
  CopilotReview,
  CopilotReviewStatus,
  CopilotFeedbackMetrics,
  CopilotLearningRecord,
} from "@/ai/copilotReviewTypes";

export interface ReviewCopilotPayload {
  status: "APPROVED" | "EDITED" | "REJECTED";
  rating?: number | null;
  comment?: string | null;
  editedResult?: Record<string, unknown> | null;
}

export interface CopilotReviewQueueItem {
  incidentId: string;
  runId: string;
  status: CopilotReviewStatus;
  title?: string;
  confidence?: number;
  risk?: string;
  warehouseName?: string;
  reasonName?: string;
  affectedOrderCount?: number;
  sampleOrderCodes?: string[];
  oldestOrderCode?: string | null;
  createdAt: string;
}

export interface ICopilotService {
  getCopilotRunByIncidentId(incidentId: string): Promise<{
    ok: boolean;
    run?: CopilotRunResult;
    activeReview?: CopilotReview | null;
    error?: string;
    message?: string;
  }>;

  reviewCopilotRun(
    incidentId: string,
    payload: ReviewCopilotPayload,
    reviewedBy?: string
  ): Promise<{
    ok: boolean;
    review?: CopilotReview;
    resumedState?: string;
    error?: string;
    message?: string;
  }>;

  getReviewHistory(incidentId: string): Promise<{
    ok: boolean;
    reviews?: CopilotReview[];
    error?: string;
    message?: string;
  }>;

  getReviewQueue(limit?: number): Promise<{
    ok: boolean;
    items?: CopilotReviewQueueItem[];
    error?: string;
    message?: string;
  }>;

  getEffectiveReviewedResult(incidentId: string): Promise<{
    ok: boolean;
    effectiveResult?: Record<string, unknown>;
    status?: CopilotReviewStatus;
    error?: string;
    message?: string;
  }>;

  getFeedbackMetrics(): Promise<{
    ok: boolean;
    metrics?: CopilotFeedbackMetrics;
    error?: string;
    message?: string;
  }>;

  getLearningDataset(limit?: number): Promise<{
    ok: boolean;
    records?: CopilotLearningRecord[];
    error?: string;
    message?: string;
  }>;
}
