// src/services/impl/CopilotService.ts

import type {
  ICopilotService,
  ReviewCopilotPayload,
} from "../interfaces/ICopilotService";
import type {
  CopilotRunResult,
  CopilotReview,
  CopilotReviewStatus,
  CopilotFeedbackMetrics,
  CopilotLearningRecord,
} from "@/ai/copilotReviewTypes";
import type { CopilotReviewQueueItem } from "../interfaces/ICopilotService";
import type { ICopilotRepository } from "@/repositories/interfaces/ICopilotRepository";
import { AIWorkflowService } from "@/workflow/AIWorkflowService";
import { logger } from "@/observability/logger";

export class CopilotService implements ICopilotService {
  constructor(private copilotRepo: ICopilotRepository) {}

  async getCopilotRunByIncidentId(incidentId: string): Promise<{
    ok: boolean;
    run?: CopilotRunResult;
    activeReview?: CopilotReview | null;
    error?: string;
    message?: string;
  }> {
    try {
      const runRow = await this.copilotRepo.getLatestCopilotRunByIncidentId(incidentId);
      if (!runRow) {
        return {
          ok: false,
          error: "NotFound",
          message: `No Copilot run found for incident '${incidentId}'.`,
        };
      }

      const activeReviewRow = await this.copilotRepo.getActiveReviewByRunId(runRow.id);

      const run: CopilotRunResult = {
        runId: runRow.id,
        incidentId: runRow.incident_id,
        workflowId: runRow.workflow_id,
        promptId: runRow.prompt_id,
        promptVersion: runRow.prompt_version,
        provider: runRow.provider,
        model: runRow.model,
        copilotResult: runRow.copilot_result,
        createdAt: runRow.created_at || new Date().toISOString(),
      };

      const activeReview: CopilotReview | null = activeReviewRow
        ? {
            reviewId: activeReviewRow.id,
            runId: activeReviewRow.run_id,
            incidentId: activeReviewRow.incident_id,
            workflowId: activeReviewRow.workflow_id,
            status: activeReviewRow.status,
            isActive: activeReviewRow.is_active,
            reviewedBy: activeReviewRow.reviewed_by,
            rating: activeReviewRow.rating,
            comment: activeReviewRow.comment,
            editedResult: activeReviewRow.edited_result,
            originalPromptId: activeReviewRow.prompt_id,
            originalPromptVersion: activeReviewRow.prompt_version,
            provider: activeReviewRow.provider,
            model: activeReviewRow.model,
            reviewedAt: activeReviewRow.reviewed_at || new Date().toISOString(),
            createdAt: activeReviewRow.created_at || new Date().toISOString(),
          }
        : null;

      return { ok: true, run, activeReview };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        component: "CopilotService",
        operation: "getCopilotRunByIncidentId",
        status: "warning",
        message,
      });
      return { ok: false, error: "GetCopilotRunFailed", message };
    }
  }

  async reviewCopilotRun(
    incidentId: string,
    payload: ReviewCopilotPayload,
    reviewedBy?: string
  ): Promise<{
    ok: boolean;
    review?: CopilotReview;
    resumedState?: string;
    error?: string;
    message?: string;
  }> {
    const startTime = Date.now();
    try {
      const { status, rating, comment, editedResult } = payload;

      if (!status || !["APPROVED", "EDITED", "REJECTED"].includes(status)) {
        return {
          ok: false,
          error: "InvalidStatus",
          message: "status must be one of 'APPROVED', 'EDITED', or 'REJECTED'.",
        };
      }

      if (status === "EDITED" && (!editedResult || typeof editedResult !== "object")) {
        return {
          ok: false,
          error: "MissingEditedResult",
          message: "editedResult is required when review status is 'EDITED'.",
        };
      }

      if (rating !== undefined && rating !== null) {
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return {
            ok: false,
            error: "InvalidRating",
            message: "rating must be an integer between 1 and 5.",
          };
        }
      }

      const runRow = await this.copilotRepo.getLatestCopilotRunByIncidentId(incidentId);
      if (!runRow) {
        return {
          ok: false,
          error: "NotFound",
          message: `No Copilot run found for incident '${incidentId}'.`,
        };
      }

      const reviewRow = await this.copilotRepo.createReview({
        run_id: runRow.id,
        incident_id: incidentId,
        workflow_id: runRow.workflow_id,
        status: status as CopilotReviewStatus,
        is_active: true,
        reviewed_by: reviewedBy ? String(reviewedBy).trim() : "operator",
        rating: rating ?? null,
        comment: comment ? String(comment).trim() : null,
        edited_result: status === "EDITED" ? editedResult : null,
        prompt_id: runRow.prompt_id,
        prompt_version: runRow.prompt_version,
        provider: runRow.provider,
        model: runRow.model,
        reviewed_at: new Date().toISOString(),
      });

      // Workflow deterministic resume
      const workflowService = new AIWorkflowService(runRow.workflow_id);
      const resumeRes = await workflowService.resumeAfterCopilotReview(incidentId);

      const durationMs = Date.now() - startTime;
      logger.info({
        component: "CopilotService",
        operation: "reviewCopilotRun",
        workflowId: runRow.workflow_id,
        incidentId,
        runId: runRow.id,
        reviewId: reviewRow.id,
        reviewStatus: status,
        promptVersion: runRow.prompt_version,
        provider: runRow.provider,
        model: runRow.model,
        durationMs,
        status: "success",
      });

      const review: CopilotReview = {
        reviewId: reviewRow.id,
        runId: reviewRow.run_id,
        incidentId: reviewRow.incident_id,
        workflowId: reviewRow.workflow_id,
        status: reviewRow.status,
        isActive: reviewRow.is_active,
        reviewedBy: reviewRow.reviewed_by,
        rating: reviewRow.rating,
        comment: reviewRow.comment,
        editedResult: reviewRow.edited_result,
        originalPromptId: reviewRow.prompt_id,
        originalPromptVersion: reviewRow.prompt_version,
        provider: reviewRow.provider,
        model: reviewRow.model,
        reviewedAt: reviewRow.reviewed_at || new Date().toISOString(),
        createdAt: reviewRow.created_at || new Date().toISOString(),
      };

      return { ok: true, review, resumedState: resumeRes.state };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        component: "CopilotService",
        operation: "reviewCopilotRun",
        status: "warning",
        message,
      });
      return { ok: false, error: "ReviewCopilotRunFailed", message };
    }
  }

  async getReviewHistory(incidentId: string): Promise<{
    ok: boolean;
    reviews?: CopilotReview[];
    error?: string;
    message?: string;
  }> {
    try {
      const rows = await this.copilotRepo.listReviewsByIncidentId(incidentId);
      const reviews: CopilotReview[] = rows.map((r) => ({
        reviewId: r.id,
        runId: r.run_id,
        incidentId: r.incident_id,
        workflowId: r.workflow_id,
        status: r.status,
        isActive: r.is_active,
        reviewedBy: r.reviewed_by,
        rating: r.rating,
        comment: r.comment,
        editedResult: r.edited_result,
        originalPromptId: r.prompt_id,
        originalPromptVersion: r.prompt_version,
        provider: r.provider,
        model: r.model,
        reviewedAt: r.reviewed_at || new Date().toISOString(),
        createdAt: r.created_at || new Date().toISOString(),
      }));
      return { ok: true, reviews };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetReviewHistoryFailed", message };
    }
  }

  async getReviewQueue(limit: number = 100): Promise<{
    ok: boolean;
    items?: CopilotReviewQueueItem[];
    error?: string;
    message?: string;
  }> {
    try {
      const runs = await this.copilotRepo.listRecentCopilotRuns(Math.min(Math.max(limit, 1), 100));
      const items = await Promise.all(runs.map(async (run) => {
        const activeReview = await this.copilotRepo.getActiveReviewByRunId(run.id);
        const result = (run.copilot_result || {}) as Record<string, any>;
        const overallRisk = result.risk?.overallRisk;
        return {
          incidentId: run.incident_id,
          runId: run.id,
          status: (activeReview?.status || "PENDING") as CopilotReviewQueueItem["status"],
          title: typeof result.summary?.title === "string" ? result.summary.title : undefined,
          confidence: typeof result.confidence === "number" ? result.confidence : typeof result.confidence?.score === "number" ? result.confidence.score : undefined,
          risk: typeof overallRisk === "string" ? overallRisk : overallRisk?.level,
          createdAt: run.created_at || new Date().toISOString(),
        };
      }));
      return { ok: true, items };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetReviewQueueFailed", message };
    }
  }

  async getEffectiveReviewedResult(incidentId: string): Promise<{
    ok: boolean;
    effectiveResult?: Record<string, unknown>;
    status?: CopilotReviewStatus;
    error?: string;
    message?: string;
  }> {
    try {
      const runRow = await this.copilotRepo.getLatestCopilotRunByIncidentId(incidentId);
      if (!runRow) {
        return {
          ok: false,
          error: "NotFound",
          message: `No Copilot run found for incident '${incidentId}'.`,
        };
      }

      const activeReview = await this.copilotRepo.getActiveReviewByRunId(runRow.id);
      const status: CopilotReviewStatus = activeReview ? activeReview.status : "PENDING";
      const effectiveResult = activeReview?.edited_result || runRow.copilot_result;

      return { ok: true, effectiveResult, status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetEffectiveResultFailed", message };
    }
  }

  async getFeedbackMetrics(): Promise<{
    ok: boolean;
    metrics?: CopilotFeedbackMetrics;
    error?: string;
    message?: string;
  }> {
    try {
      const allReviews = await this.copilotRepo.getAllReviews(1000);
      const finalized = allReviews.filter((r) =>
        ["APPROVED", "EDITED", "REJECTED"].includes(r.status)
      );

      const totalReviews = finalized.length;
      if (totalReviews === 0) {
        return {
          ok: true,
          metrics: {
            totalReviews: 0,
            approvalRate: 0,
            editRate: 0,
            rejectionRate: 0,
            averageRating: null,
            riskAgreement: 0,
            escalationAgreement: 0,
            recommendationAgreement: 0,
          },
        };
      }

      const approvedCount = finalized.filter((r) => r.status === "APPROVED").length;
      const editedCount = finalized.filter((r) => r.status === "EDITED").length;
      const rejectedCount = finalized.filter((r) => r.status === "REJECTED").length;

      const ratings = finalized
        .map((r) => r.rating)
        .filter((rt): rt is number => typeof rt === "number");
      const averageRating =
        ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

      const approvalRate = Number((approvedCount / totalReviews).toFixed(4));
      const editRate = Number((editedCount / totalReviews).toFixed(4));
      const rejectionRate = Number((rejectedCount / totalReviews).toFixed(4));

      const riskAgreement = Number(((approvedCount + editedCount * 0.8) / totalReviews).toFixed(4));
      const escalationAgreement = Number(((approvedCount + editedCount * 0.7) / totalReviews).toFixed(4));
      const recommendationAgreement = Number(
        ((approvedCount + editedCount * 0.9) / totalReviews).toFixed(4)
      );

      return {
        ok: true,
        metrics: {
          totalReviews,
          approvalRate,
          editRate,
          rejectionRate,
          averageRating: averageRating !== null ? Number(averageRating.toFixed(2)) : null,
          riskAgreement,
          escalationAgreement,
          recommendationAgreement,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetFeedbackMetricsFailed", message };
    }
  }

  async getLearningDataset(limit: number = 100): Promise<{
    ok: boolean;
    records?: CopilotLearningRecord[];
    error?: string;
    message?: string;
  }> {
    try {
      const allReviews = await this.copilotRepo.getAllReviews(limit);
      const finalized = allReviews.filter((r) =>
        ["APPROVED", "EDITED", "REJECTED"].includes(r.status)
      );

      const records: CopilotLearningRecord[] = [];

      for (const rev of finalized) {
        const runRow = await this.copilotRepo.getCopilotRunById(rev.run_id);
        if (!runRow) continue;

        let humanApprovedResult: Record<string, unknown> | null = null;
        if (rev.status === "APPROVED") {
          humanApprovedResult = runRow.copilot_result;
        } else if (rev.status === "EDITED") {
          humanApprovedResult = rev.edited_result || null;
        } else if (rev.status === "REJECTED") {
          humanApprovedResult = null;
        }

        records.push({
          incidentId: rev.incident_id,
          runId: rev.run_id,
          workflowId: rev.workflow_id,
          promptId: rev.prompt_id,
          promptVersion: rev.prompt_version,
          provider: rev.provider,
          model: rev.model,
          originalResult: runRow.copilot_result,
          humanApprovedResult,
          status: rev.status,
          rating: rev.rating,
          comment: rev.comment,
          reviewedAt: rev.reviewed_at || new Date().toISOString(),
        });
      }

      return { ok: true, records };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetLearningDatasetFailed", message };
    }
  }
}
