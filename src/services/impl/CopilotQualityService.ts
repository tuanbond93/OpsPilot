// src/services/impl/CopilotQualityService.ts

import type { ICopilotQualityService, QualitySummary } from "../interfaces/ICopilotQualityService";
import type { ICopilotRepository } from "@/repositories/interfaces/ICopilotRepository";
import { CopilotService } from "./CopilotService";
import { buildProductionDataset } from "@/evaluation/productionDataset";
import { calculateConfidenceCalibration } from "@/evaluation/confidenceCalibration";
import { comparePromptsAndModels } from "@/evaluation/copilotComparison";
import { logger } from "@/observability/logger";

export class CopilotQualityService implements ICopilotQualityService {
  private copilotService: CopilotService;

  constructor(private copilotRepo: ICopilotRepository) {
    this.copilotService = new CopilotService(copilotRepo);
  }

  async getQualitySummary(): Promise<{
    ok: boolean;
    summary?: QualitySummary;
    error?: string;
    message?: string;
  }> {
    const startTime = Date.now();
    try {
      const learningRes = await this.copilotService.getLearningDataset(1000);
      const learningRecords = learningRes.records || [];

      const productionDataset = buildProductionDataset(learningRecords);
      const calibration = calculateConfidenceCalibration(productionDataset.records);
      const comparisons = comparePromptsAndModels(productionDataset.records);

      const total = productionDataset.totalRecords;
      const approved = productionDataset.approvedCount;
      const edited = productionDataset.editedCount;
      const rejected = productionDataset.rejectedCount;

      const approvalRate = total > 0 ? Number((approved / total).toFixed(4)) : 0;
      const editRate = total > 0 ? Number((edited / total).toFixed(4)) : 0;
      const rejectionRate = total > 0 ? Number((rejected / total).toFixed(4)) : 0;

      const feedbackMetricsRes = await this.copilotService.getFeedbackMetrics();
      const avgRating = feedbackMetricsRes.metrics?.averageRating ?? null;

      // Agreement section averages
      let sumExec = 0, sumRC = 0, sumEv = 0, sumRec = 0, sumImp = 0, sumEsc = 0, sumRisk = 0;
      for (const r of productionDataset.records) {
        sumExec += r.agreementScores.executiveSummaryAgreement;
        sumRC += r.agreementScores.rootCauseAgreement;
        sumEv += r.agreementScores.evidenceAgreement;
        sumRec += r.agreementScores.recommendationsAgreement;
        sumImp += r.agreementScores.businessImpactAgreement;
        sumEsc += r.agreementScores.escalationAgreement;
        sumRisk += r.agreementScores.riskAssessmentAgreement;
      }

      const agreementMetrics = {
        overallAgreement: productionDataset.overallAverageAgreement,
        weightedAgreement: productionDataset.weightedAverageAgreement,
        executiveSummaryAgreement: total > 0 ? Math.round(sumExec / total) : 0,
        rootCauseAgreement: total > 0 ? Math.round(sumRC / total) : 0,
        evidenceAgreement: total > 0 ? Math.round(sumEv / total) : 0,
        recommendationsAgreement: total > 0 ? Math.round(sumRec / total) : 0,
        businessImpactAgreement: total > 0 ? Math.round(sumImp / total) : 0,
        escalationAgreement: total > 0 ? Math.round(sumEsc / total) : 0,
        riskAssessmentAgreement: total > 0 ? Math.round(sumRisk / total) : 0,
      };

      // Overall AI Quality Score: 50% Weighted Agreement + 30% Approval Rate + 20% Calibration Score
      const overallQualityScore = total > 0
        ? Math.round(productionDataset.weightedAverageAgreement * 0.5 + approvalRate * 100 * 0.3 + calibration.calibrationScore * 0.2)
        : null;

      // Release Readiness Score: 40% Weighted Agreement + 40% Approval Rate + 20% (1 - Overconfidence)
      const releaseReadinessScore = total > 0
        ? Math.round(productionDataset.weightedAverageAgreement * 0.4 + approvalRate * 100 * 0.4 + (1 - calibration.overconfidenceRate) * 100 * 0.2)
        : null;

      // Group trends by date
      const recentTrends = groupTrendsByDate(productionDataset.records);

      const evaluationDuration = Date.now() - startTime;
      logger.info({
        component: "CopilotQualityService",
        operation: "getQualitySummary",
        totalEvaluated: total,
        agreementScore: productionDataset.weightedAverageAgreement,
        confidence: calibration.calibrationScore,
        status: "success",
        evaluationDuration,
      });

      const summary: QualitySummary = {
        overallQualityScore,
        releaseReadinessScore,
        totalEvaluated: total,
        reviewMetrics: {
          totalReviews: total,
          approvalRate,
          editRate,
          rejectionRate,
          averageRating: avgRating,
        },
        agreementMetrics,
        confidenceMetrics: calibration,
        promptComparison: comparisons.promptVersionComparison,
        modelComparison: comparisons.modelComparison,
        recentTrends,
      };

      return { ok: true, summary };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        component: "CopilotQualityService",
        operation: "getQualitySummary",
        status: "warning",
        message,
      });
      return { ok: false, error: "GetQualitySummaryFailed", message };
    }
  }

  async getQualityHistory(): Promise<{
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
  }> {
    try {
      const learningRes = await this.copilotService.getLearningDataset(1000);
      const records = (learningRes.records || []).sort(
        (a, b) => new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime()
      );

      const groupedByDay: Record<string, typeof records> = {};
      for (const r of records) {
        const day = r.reviewedAt.substring(0, 10);
        if (!groupedByDay[day]) groupedByDay[day] = [];
        groupedByDay[day].push(r);
      }

      const history = Object.entries(groupedByDay).map(([date, recs]) => {
        const dataset = buildProductionDataset(recs);
        const cal = calculateConfidenceCalibration(dataset.records);
        const total = dataset.totalRecords;
        return {
          date,
          totalReviews: total,
          approvalRate: total > 0 ? Number((dataset.approvedCount / total).toFixed(4)) : 0,
          editRate: total > 0 ? Number((dataset.editedCount / total).toFixed(4)) : 0,
          rejectionRate: total > 0 ? Number((dataset.rejectedCount / total).toFixed(4)) : 0,
          weightedAgreement: dataset.weightedAverageAgreement,
          calibrationScore: cal.calibrationScore,
        };
      });

      return { ok: true, history };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "GetQualityHistoryFailed", message };
    }
  }
}

import type { ProductionEvaluationRecord } from "@/evaluation/productionDataset";

function groupTrendsByDate(
  records: ProductionEvaluationRecord[]
): Array<{
  date: string;
  totalReviews: number;
  approvalRate: number;
  weightedAgreement: number;
}> {
  const grouped: Record<string, typeof records> = {};
  for (const r of records) {
    const d = r.reviewedAt.substring(0, 10);
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(r);
  }

  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const total = list.length;
      const approved = list.filter((r) => r.status === "APPROVED").length;
      const sumWeighted = list.reduce((acc, curr) => acc + curr.agreementScores.weightedAgreement, 0);
      return {
        date,
        totalReviews: total,
        approvalRate: total > 0 ? Number((approved / total).toFixed(4)) : 0,
        weightedAgreement: total > 0 ? Math.round(sumWeighted / total) : 0,
      };
    });
}
