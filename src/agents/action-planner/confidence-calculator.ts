import type { Confidence, ConfidenceFactor, PlannerRecommendation } from "./schema";
import type { IncidentHistoryRow, FollowupCaseRow, OrderExceptionRow } from "@/connectors/supabase";
import type { RootCauseResult } from "../root-cause/schema";

export function calculateConfidence(
  historyRows: IncidentHistoryRow[] = [],
  rootCauseResult?: RootCauseResult | null,
  followupCase?: FollowupCaseRow | null,
  exceptions: OrderExceptionRow[] = [],
  missingData: string[] = [],
  activeRecommendations: PlannerRecommendation[] = []
): Confidence {
  const factors: ConfidenceFactor[] = [];
  let rawScore = 0;

  // 1. Data Completeness (max +40)
  let completenessScore = 0;
  if (historyRows.length > 0) completenessScore += 10;
  if (rootCauseResult) completenessScore += 10;
  if (followupCase) completenessScore += 10;
  if (exceptions.length >= 0) completenessScore += 10;

  rawScore += completenessScore;
  factors.push({
    code: "DATA_COMPLETENESS",
    contribution: completenessScore,
    explanation: `Mức độ đầy đủ của nguồn dữ liệu tổng hợp (+${completenessScore}/40 điểm).`,
  });

  // 2. Root Cause Agent Confidence (max +30)
  let rcContribution = 0;
  if (rootCauseResult && typeof rootCauseResult.confidence === "number") {
    rcContribution = Math.round((rootCauseResult.confidence / 100) * 30);
  } else {
    rcContribution = 15;
  }
  rawScore += rcContribution;
  factors.push({
    code: "ROOT_CAUSE_CONFIDENCE",
    contribution: rcContribution,
    explanation: `Độ tin cậy từ Chẩn đoán nguyên nhân (+${rcContribution}/30 điểm).`,
  });

  // 3. Incident History Quality (max +30)
  let historyContribution = 0;
  if (historyRows.length >= 5) historyContribution = 30;
  else if (historyRows.length >= 3) historyContribution = 20;
  else if (historyRows.length >= 1) historyContribution = 10;

  rawScore += historyContribution;
  factors.push({
    code: "HISTORY_QUALITY",
    contribution: historyContribution,
    explanation: `Chất lượng độ sâu chuỗi lịch sử sự cố với ${historyRows.length} mốc snapshot (+${historyContribution}/30 điểm).`,
  });

  // 4. Relevant Missing Data Penalty
  // Missing data reduces confidence ONLY when necessary for selected active recommendations
  const relevantMissingData: string[] = [];
  for (const m of missingData) {
    if (m === "NO_STAFFING_DATA") {
      const needsStaffing = activeRecommendations.some(
        (r) =>
          r.type === "REVIEW_ASSIGNMENT" ||
          (r.prerequisiteData && r.prerequisiteData.some((p) => p.includes("nhân sự") || p.includes("ca trực")))
      );
      if (needsStaffing) relevantMissingData.push(m);
    } else if (m === "NO_VEHICLE_GPS_DATA") {
      const needsVehicle = activeRecommendations.some(
        (r) => r.prerequisiteData && r.prerequisiteData.some((p) => p.includes("xe") || p.includes("phương tiện"))
      );
      if (needsVehicle) relevantMissingData.push(m);
    } else if (m === "NO_ROUTE_CAPACITY_DATA") {
      const needsRoute = activeRecommendations.some(
        (r) => r.prerequisiteData && r.prerequisiteData.some((p) => p.includes("tuyến") || p.includes("lộ trình"))
      );
      if (needsRoute) relevantMissingData.push(m);
    }
  }

  const penaltyPerVector = 10;
  const totalPenalty = relevantMissingData.length * penaltyPerVector;
  if (totalPenalty > 0) {
    rawScore -= totalPenalty;
    factors.push({
      code: "RELEVANT_MISSING_DATA_PENALTY",
      contribution: -totalPenalty,
      explanation: `Khấu trừ do thiếu dữ liệu cần thiết cho khuyến nghị đang chọn: ${relevantMissingData.join(", ")} (-${totalPenalty} điểm).`,
    });
  }

  // Final score capped strictly between 0 and 100
  const score = Math.max(0, Math.min(100, rawScore));

  let level: "high" | "medium" | "low" = "medium";
  if (score >= 80) level = "high";
  else if (score < 50) level = "low";

  return {
    score,
    level,
    factors,
  };
}
