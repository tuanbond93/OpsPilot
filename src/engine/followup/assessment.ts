import type { ProgressAssessment } from "./types";

export interface AssessmentResult {
  countChangePercent: number; // Negative when count decreases, e.g. -8%
  progressPercent: number; // Positive for improvement, e.g. 8% for 100 -> 92
  assessment: ProgressAssessment;
}

/**
 * Evaluates progress assessment from baseline and current affected order counts.
 * Clarified Progress Sign Semantics:
 * - countChangePercent = ((currentCount - baselineCount) / baselineCount) * 100
 * - progressPercent = ((baselineCount - currentCount) / baselineCount) * 100 (Positive for reduction/improvement)
 * 
 * Rules:
 * - progressPercent >= 20%: strong_progress
 * - 5% <= progressPercent < 20%: limited_progress
 * - -5% < progressPercent < 5%: no_progress
 * - progressPercent <= -5%: worsening
 * - Insufficient history (<2 points): insufficient_data
 */
export function evaluateProgressAssessment(
  currentCount: number,
  baselineCount: number,
  historyPointCount: number
): AssessmentResult {
  if (historyPointCount < 2 || baselineCount <= 0) {
    return {
      countChangePercent: 0,
      progressPercent: 0,
      assessment: "insufficient_data",
    };
  }

  const changeAbsolute = currentCount - baselineCount;
  const countChangePercent = Math.round((changeAbsolute / baselineCount) * 1000) / 10;
  const progressPercent = Math.round(((baselineCount - currentCount) / baselineCount) * 1000) / 10;

  let assessment: ProgressAssessment = "no_progress";

  if (progressPercent >= 20) {
    assessment = "strong_progress";
  } else if (progressPercent >= 5 && progressPercent < 20) {
    assessment = "limited_progress";
  } else if (progressPercent > -5 && progressPercent < 5) {
    assessment = "no_progress";
  } else {
    assessment = "worsening";
  }

  return {
    countChangePercent,
    progressPercent,
    assessment,
  };
}
