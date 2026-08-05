import type { DeterministicContext } from "./context-builder";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskFactor {
  code: string;
  label: string;
  contribution: number;
  evidence: string;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

export interface RiskConfig {
  orderCountWeights: {
    tier1: { min: 1; max: 20; points: 5 };
    tier2: { min: 21; max: 50; points: 10 };
    tier3: { min: 51; max: 100; points: 20 };
    tier4: { min: 101; points: 30 };
  };
  maxAgeWeights: {
    h24: 10;
    h48: 20;
    h72: 30;
  };
  trendWeights: {
    decreasingStrong: 0; // > 20% reduction
    decreasingLight: 5; // 1-20% reduction
    unchanged: 15; // +- 1%
    increasingLight: 20; // 1-20% increase
    increasingStrong: 30; // > 20% increase
  };
  durationWeights: {
    h4: 5;
    h8: 10;
    h24: 20;
  };
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  orderCountWeights: {
    tier1: { min: 1, max: 20, points: 5 },
    tier2: { min: 21, max: 50, points: 10 },
    tier3: { min: 51, max: 100, points: 20 },
    tier4: { min: 101, points: 30 },
  },
  maxAgeWeights: {
    h24: 10,
    h48: 20,
    h72: 30,
  },
  trendWeights: {
    decreasingStrong: 0,
    decreasingLight: 5,
    unchanged: 15,
    increasingLight: 20,
    increasingStrong: 30,
  },
  durationWeights: {
    h4: 5,
    h8: 10,
    h24: 20,
  },
};

/**
 * Deterministically calculates risk score, level, and factor contributions
 */
export function calculateDeterministicRisk(
  context: DeterministicContext,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): RiskResult {
  const factors: RiskFactor[] = [];
  let rawScore = 0;

  // 1. Affected order count score
  const count = context.currentAffectedCount;
  let countPoints = 0;
  if (count > 100) {
    countPoints = config.orderCountWeights.tier4.points;
  } else if (count >= 51) {
    countPoints = config.orderCountWeights.tier3.points;
  } else if (count >= 21) {
    countPoints = config.orderCountWeights.tier2.points;
  } else if (count >= 1) {
    countPoints = config.orderCountWeights.tier1.points;
  }

  if (countPoints > 0) {
    factors.push({
      code: "FACTOR_ORDER_COUNT",
      label: "Số lượng đơn hàng bị ảnh hưởng",
      contribution: countPoints,
      evidence: `${count} đơn hàng bị ảnh hưởng (+${countPoints} điểm).`,
    });
    rawScore += countPoints;
  }

  // 2. Maximum age score (highest applicable non-cumulative)
  const maxAge = context.maximumAgeHours || 0;
  let agePoints = 0;
  if (maxAge >= 72) {
    agePoints = config.maxAgeWeights.h72;
  } else if (maxAge >= 48) {
    agePoints = config.maxAgeWeights.h48;
  } else if (maxAge >= 24) {
    agePoints = config.maxAgeWeights.h24;
  }

  if (agePoints > 0) {
    factors.push({
      code: "FACTOR_MAX_AGE",
      label: "Thời gian tồn đọng tối đa",
      contribution: agePoints,
      evidence: `Đơn hàng tồn lâu nhất là ${maxAge} giờ (+${agePoints} điểm).`,
    });
    rawScore += agePoints;
  }

  // 3. Trend score
  const changePct = context.changePercent;
  let trendPoints: number = config.trendWeights.unchanged;

  if (context.historyPointCount < 2) {
    trendPoints = config.trendWeights.unchanged;
  } else if (changePct <= -20) {
    trendPoints = config.trendWeights.decreasingStrong;
  } else if (changePct < -1) {
    trendPoints = config.trendWeights.decreasingLight;
  } else if (changePct >= -1 && changePct <= 1) {
    trendPoints = config.trendWeights.unchanged;
  } else if (changePct > 1 && changePct <= 20) {
    trendPoints = config.trendWeights.increasingLight;
  } else {
    trendPoints = config.trendWeights.increasingStrong;
  }

  factors.push({
    code: "FACTOR_TREND",
    label: "Xu hướng biến động sự cố",
    contribution: trendPoints,
    evidence:
      context.historyPointCount >= 2
        ? `Số lượng thay đổi ${changePct > 0 ? "+" : ""}${changePct}% (+${trendPoints} điểm).`
        : `Dữ liệu lịch sử chưa đủ (+${trendPoints} điểm mặc định).`,
  });
  rawScore += trendPoints;

  // 4. Incident duration score
  const duration = context.incidentDurationHours;
  let durationPoints = 0;
  if (duration >= 24) {
    durationPoints = config.durationWeights.h24;
  } else if (duration >= 8) {
    durationPoints = config.durationWeights.h8;
  } else if (duration >= 4) {
    durationPoints = config.durationWeights.h4;
  }

  if (durationPoints > 0) {
    factors.push({
      code: "FACTOR_DURATION",
      label: "Thời gian kéo dài sự cố",
      contribution: durationPoints,
      evidence: `Sự cố đã kéo dài ${duration} giờ (+${durationPoints} điểm).`,
    });
    rawScore += durationPoints;
  }

  const score = Math.min(rawScore, 100);

  let level: RiskLevel = "low";
  if (score >= 75) {
    level = "critical";
  } else if (score >= 50) {
    level = "high";
  } else if (score >= 25) {
    level = "medium";
  }

  return {
    score,
    level,
    factors,
  };
}
