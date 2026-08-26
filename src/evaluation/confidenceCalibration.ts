// src/evaluation/confidenceCalibration.ts

import type { ProductionEvaluationRecord } from "./productionDataset";

export interface CalibrationBin {
  binRange: string; // e.g. "0.8 - 1.0"
  count: number;
  accuracy: number; // 0 - 100 (% approved/edited in this bin)
  avgConfidence: number;
}

export interface ConfidenceCalibrationResult {
  totalEvaluated: number;
  highConfidenceApproved: number;
  highConfidenceRejected: number;
  lowConfidenceApproved: number;
  lowConfidenceRejected: number;
  overconfidenceRate: number;  // 0 - 1
  underconfidenceRate: number; // 0 - 1
  calibrationScore: number;    // 0 - 100
  calibrationCurve: CalibrationBin[];
}

export function calculateConfidenceCalibration(
  records: ProductionEvaluationRecord[]
): ConfidenceCalibrationResult {
  const totalEvaluated = records.length;
  if (totalEvaluated === 0) {
    return {
      totalEvaluated: 0,
      highConfidenceApproved: 0,
      highConfidenceRejected: 0,
      lowConfidenceApproved: 0,
      lowConfidenceRejected: 0,
      overconfidenceRate: 0,
      underconfidenceRate: 0,
      calibrationScore: 0,
      calibrationCurve: [
        { binRange: "0.0 - 0.2", count: 0, accuracy: 0, avgConfidence: 0.1 },
        { binRange: "0.2 - 0.4", count: 0, accuracy: 0, avgConfidence: 0.3 },
        { binRange: "0.4 - 0.6", count: 0, accuracy: 0, avgConfidence: 0.5 },
        { binRange: "0.6 - 0.8", count: 0, accuracy: 0, avgConfidence: 0.7 },
        { binRange: "0.8 - 1.0", count: 0, accuracy: 0, avgConfidence: 0.9 },
      ],
    };
  }

  let highApproved = 0;
  let highRejected = 0;
  let lowApproved = 0;
  let lowRejected = 0;

  // Initialize 5 bins: [0-0.2), [0.2-0.4), [0.4-0.6), [0.6-0.8), [0.8-1.0]
  const bins = [
    { range: "0.0 - 0.2", min: 0.0, max: 0.2, count: 0, successCount: 0, sumConf: 0 },
    { range: "0.2 - 0.4", min: 0.2, max: 0.4, count: 0, successCount: 0, sumConf: 0 },
    { range: "0.4 - 0.6", min: 0.4, max: 0.6, count: 0, successCount: 0, sumConf: 0 },
    { range: "0.6 - 0.8", min: 0.6, max: 0.8, count: 0, successCount: 0, sumConf: 0 },
    { range: "0.8 - 1.0", min: 0.8, max: 1.01, count: 0, successCount: 0, sumConf: 0 },
  ];

  for (const r of records) {
    const rawConf = typeof r.originalResult?.confidence === "number" ? r.originalResult.confidence : 0.8;
    const conf = Math.max(0, Math.min(1, rawConf));
    const isSuccess = r.status === "APPROVED" || r.status === "EDITED";

    if (conf >= 0.7) {
      if (isSuccess) highApproved++;
      else highRejected++;
    } else {
      if (isSuccess) lowApproved++;
      else lowRejected++;
    }

    const bin = bins.find((b) => conf >= b.min && conf < b.max) || bins[4];
    bin.count++;
    if (isSuccess) bin.successCount++;
    bin.sumConf += conf;
  }

  const totalHigh = highApproved + highRejected;
  const totalLow = lowApproved + lowRejected;

  const overconfidenceRate = totalHigh > 0 ? Number((highRejected / totalHigh).toFixed(4)) : 0;
  const underconfidenceRate = totalLow > 0 ? Number((lowApproved / totalLow).toFixed(4)) : 0;

  let totalCalibrationError = 0;
  let activeBinsCount = 0;

  const calibrationCurve: CalibrationBin[] = bins.map((b) => {
    const accuracy = b.count > 0 ? Math.round((b.successCount / b.count) * 100) : 0;
    const avgConfidence = b.count > 0 ? Number((b.sumConf / b.count).toFixed(2)) : (b.min + b.max) / 2;

    if (b.count > 0) {
      const confPercent = Math.round(avgConfidence * 100);
      totalCalibrationError += Math.abs(accuracy - confPercent);
      activeBinsCount++;
    }

    return {
      binRange: b.range,
      count: b.count,
      accuracy,
      avgConfidence,
    };
  });

  const avgError = activeBinsCount > 0 ? totalCalibrationError / activeBinsCount : 0;
  const calibrationScore = Math.max(0, Math.round(100 - avgError));

  return {
    totalEvaluated,
    highConfidenceApproved: highApproved,
    highConfidenceRejected: highRejected,
    lowConfidenceApproved: lowApproved,
    lowConfidenceRejected: lowRejected,
    overconfidenceRate,
    underconfidenceRate,
    calibrationScore,
    calibrationCurve,
  };
}
