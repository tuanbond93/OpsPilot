// src/ai/copilotReviewTypes.ts

export type CopilotReviewStatus = 'PENDING' | 'APPROVED' | 'EDITED' | 'REJECTED' | 'SUPERSEDED';

export interface CopilotReview {
  reviewId: string;
  runId: string;
  incidentId: string;
  workflowId: string;
  status: CopilotReviewStatus;
  isActive: boolean;
  reviewedBy?: string | null;
  rating?: number | null;
  comment?: string | null;
  editedResult?: Record<string, unknown> | null;
  originalPromptId: string;
  originalPromptVersion: string;
  provider?: string | null;
  model?: string | null;
  reviewedAt: string;
  createdAt: string;
}

export interface CopilotRunResult {
  runId: string;
  incidentId: string;
  workflowId: string;
  promptId: string;
  promptVersion: string;
  provider?: string | null;
  model?: string | null;
  copilotResult: Record<string, unknown>;
  createdAt: string;
}

export interface CopilotLearningRecord {
  incidentId: string;
  runId: string;
  workflowId: string;
  promptId: string;
  promptVersion: string;
  provider?: string | null;
  model?: string | null;
  originalResult: Record<string, unknown>;
  humanApprovedResult: Record<string, unknown> | null;
  status: CopilotReviewStatus;
  rating?: number | null;
  comment?: string | null;
  reviewedAt: string;
}

export interface CopilotFeedbackMetrics {
  totalReviews: number;
  approvalRate: number;
  editRate: number;
  rejectionRate: number;
  averageRating: number | null;
  riskAgreement: number;
  escalationAgreement: number;
  recommendationAgreement: number;
}
