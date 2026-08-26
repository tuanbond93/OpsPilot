// src/evaluation/productionDataset.ts

import type { CopilotLearningRecord, CopilotReviewStatus } from "@/ai/copilotReviewTypes";
import { calculateHumanAgreement, type DetailedAgreementScores } from "./humanAgreementEngine";

export interface ProductionEvaluationRecord {
  incidentId: string;
  runId: string;
  workflowId: string;
  promptId: string;
  promptVersion: string;
  provider: string;
  model: string;
  status: CopilotReviewStatus;
  rating: number | null;
  comment: string | null;
  originalResult: Record<string, unknown>;
  humanApprovedResult: Record<string, unknown> | null;
  agreementScores: DetailedAgreementScores;
  reviewedAt: string;
}

export interface ProductionEvaluationDataset {
  totalRecords: number;
  approvedCount: number;
  editedCount: number;
  rejectedCount: number;
  overallAverageAgreement: number;
  weightedAverageAgreement: number;
  records: ProductionEvaluationRecord[];
}

/**
 * Builds a normalized Production Evaluation Dataset from Copilot learning records.
 * Kept completely separate from synthetic golden datasets.
 */
export function buildProductionDataset(
  learningRecords: CopilotLearningRecord[]
): ProductionEvaluationDataset {
  const records: ProductionEvaluationRecord[] = [];

  let totalOverall = 0;
  let totalWeighted = 0;
  let approvedCount = 0;
  let editedCount = 0;
  let rejectedCount = 0;

  for (const rec of learningRecords) {
    if (rec.status === "APPROVED") approvedCount++;
    else if (rec.status === "EDITED") editedCount++;
    else if (rec.status === "REJECTED") rejectedCount++;

    const agreement = calculateHumanAgreement(
      rec.originalResult,
      rec.humanApprovedResult,
      rec.status
    );

    totalOverall += agreement.overallAgreement;
    totalWeighted += agreement.weightedAgreement;

    records.push({
      incidentId: rec.incidentId,
      runId: rec.runId,
      workflowId: rec.workflowId,
      promptId: rec.promptId,
      promptVersion: rec.promptVersion,
      provider: rec.provider || "openai",
      model: rec.model || "default",
      status: rec.status,
      rating: rec.rating ?? null,
      comment: rec.comment ?? null,
      originalResult: rec.originalResult,
      humanApprovedResult: rec.humanApprovedResult,
      agreementScores: agreement,
      reviewedAt: rec.reviewedAt,
    });
  }

  const total = records.length;
  const overallAverageAgreement = total > 0 ? Math.round(totalOverall / total) : 0;
  const weightedAverageAgreement = total > 0 ? Math.round(totalWeighted / total) : 0;

  return {
    totalRecords: total,
    approvedCount,
    editedCount,
    rejectedCount,
    overallAverageAgreement,
    weightedAverageAgreement,
    records,
  };
}
