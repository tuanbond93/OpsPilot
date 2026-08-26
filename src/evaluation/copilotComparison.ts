// src/evaluation/copilotComparison.ts

import type { ProductionEvaluationRecord } from "./productionDataset";

export interface VersionComparisonMetrics {
  versionOrModel: string;
  totalReviews: number;
  approvalRate: number; // 0 - 1
  editRate: number;     // 0 - 1
  rejectionRate: number;// 0 - 1
  overallAgreementScore: number; // 0 - 100
  weightedAgreementScore: number;// 0 - 100
  avgConfidence: number; // 0 - 1
}

export function comparePromptsAndModels(
  records: ProductionEvaluationRecord[]
): {
  promptVersionComparison: VersionComparisonMetrics[];
  modelComparison: VersionComparisonMetrics[];
} {
  const promptGroups = groupByKey(records, (r) => `${r.promptId}@${r.promptVersion}`);
  const modelGroups = groupByKey(records, (r) => `${r.provider}:${r.model}`);

  return {
    promptVersionComparison: summarizeGroups(promptGroups),
    modelComparison: summarizeGroups(modelGroups),
  };
}

function groupByKey(
  records: ProductionEvaluationRecord[],
  keyFn: (r: ProductionEvaluationRecord) => string
): Record<string, ProductionEvaluationRecord[]> {
  const groups: Record<string, ProductionEvaluationRecord[]> = {};
  for (const r of records) {
    const k = keyFn(r);
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  }
  return groups;
}

function summarizeGroups(
  groups: Record<string, ProductionEvaluationRecord[]>
): VersionComparisonMetrics[] {
  const results: VersionComparisonMetrics[] = [];

  for (const [key, list] of Object.entries(groups)) {
    const total = list.length;
    if (total === 0) continue;

    const approved = list.filter((r) => r.status === "APPROVED").length;
    const edited = list.filter((r) => r.status === "EDITED").length;
    const rejected = list.filter((r) => r.status === "REJECTED").length;

    let sumOverall = 0;
    let sumWeighted = 0;
    let sumConf = 0;

    for (const r of list) {
      sumOverall += r.agreementScores.overallAgreement;
      sumWeighted += r.agreementScores.weightedAgreement;
      const conf = typeof r.originalResult?.confidence === "number" ? r.originalResult.confidence : 0.8;
      sumConf += conf;
    }

    results.push({
      versionOrModel: key,
      totalReviews: total,
      approvalRate: Number((approved / total).toFixed(4)),
      editRate: Number((edited / total).toFixed(4)),
      rejectionRate: Number((rejected / total).toFixed(4)),
      overallAgreementScore: Math.round(sumOverall / total),
      weightedAgreementScore: Math.round(sumWeighted / total),
      avgConfidence: Number((sumConf / total).toFixed(2)),
    });
  }

  return results.sort((a, b) => b.totalReviews - a.totalReviews);
}
