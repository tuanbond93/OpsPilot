// src/services/interfaces/ICopilotQualityService.ts

import type { VersionComparisonMetrics } from "@/evaluation/copilotComparison";
import type { ConfidenceCalibrationResult } from "@/evaluation/confidenceCalibration";

export interface QualitySummary {
  overallQualityScore: number | null;    // 0 - 100; null when no human evidence exists
  releaseReadinessScore: number | null;  // 0 - 100; null when no human evidence exists
  totalEvaluated: number;
  reviewMetrics: {
    totalReviews: number;
    approvalRate: number;
    editRate: number;
    rejectionRate: number;
    averageRating: number | null;
  };
  agreementMetrics: {
    overallAgreement: number;
    weightedAgreement: number;
    executiveSummaryAgreement: number;
    rootCauseAgreement: number;
    evidenceAgreement: number;
    recommendationsAgreement: number;
    businessImpactAgreement: number;
    escalationAgreement: number;
    riskAssessmentAgreement: number;
  };
  confidenceMetrics: ConfidenceCalibrationResult;
  promptComparison: VersionComparisonMetrics[];
  modelComparison: VersionComparisonMetrics[];
  recentTrends: Array<{
    date: string;
    totalReviews: number;
    approvalRate: number;
    weightedAgreement: number;
  }>;
}

export interface ICopilotQualityService {
  getQualitySummary(): Promise<{
    ok: boolean;
    summary?: QualitySummary;
    error?: string;
    message?: string;
  }>;

  getQualityHistory(): Promise<{
    ok: boolean;
    history?: Array<{
      date: string;
      totalReviews: number;
      approvalRate: number;
      editRate: number;
      rejectionRate: number;
      weightedAgreement: number;
      calibrationScore: number;
    }>;
    error?: string;
    message?: string;
  }>;
}
