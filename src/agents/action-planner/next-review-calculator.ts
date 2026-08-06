import type { NextReview } from "./schema";
import type { FollowupCaseRow } from "@/connectors/supabase";

export function calculateNextReview(
  followupCase?: FollowupCaseRow | null,
  riskLevel: "low" | "medium" | "high" | "critical" = "medium",
  trendAssessment: string = "insufficient_data",
  referenceTimeMs: number = Date.now()
): NextReview {
  // Rule 1: Active Follow-up Case schedule takes precedence
  if (followupCase?.next_action_at) {
    const nextActionMs = new Date(followupCase.next_action_at).getTime();
    if (!isNaN(nextActionMs) && nextActionMs > 0) {
      const diffMs = nextActionMs - referenceTimeMs;
      const reviewAfterMinutes = Math.max(1, Math.round(diffMs / 60000));

      return {
        source: "FOLLOWUP_POLICY",
        reviewAt: new Date(nextActionMs).toISOString(),
        reviewAfterMinutes,
        rationale: `Lịch đánh giá trùng khớp với chu kỳ Follow-up State Machine hiện tại (${followupCase.current_state}).`,
      };
    }
  }

  // Rule 2: Deterministic Planner Policy
  let reviewAfterMinutes = 120; // Default 2 hours
  let rationale = "Đánh giá định kỳ theo quy trình tiêu chuẩn 2 giờ.";

  if (riskLevel === "critical" && (trendAssessment === "worsening" || trendAssessment === "stagnant")) {
    reviewAfterMinutes = 60; // 1 hour for critical worsening
    rationale = "Sự cố ở mức NGUY CẤP (Critical) và xu hướng xấu đi. Yêu cầu tái đánh giá sau 60 phút.";
  } else if (riskLevel === "critical" || riskLevel === "high") {
    reviewAfterMinutes = 120; // 2 hours
    rationale = "Sự cố có mức độ rủi ro CAO (High/Critical). Đánh giá lại sau 120 phút.";
  } else if (riskLevel === "medium") {
    reviewAfterMinutes = 120; // 2 hours
    rationale = "Sự cố ở mức rủi ro TRUNG BÌNH (Medium). Tái đánh giá theo chu kỳ 120 phút.";
  } else if (riskLevel === "low") {
    reviewAfterMinutes = 240; // 4 hours
    rationale = "Sự cố ở mức rủi ro THẤP (Low). Tái kiểm tra sau 240 phút.";
  }

  const reviewAt = new Date(referenceTimeMs + reviewAfterMinutes * 60000).toISOString();

  return {
    source: "PLANNER_POLICY",
    reviewAt,
    reviewAfterMinutes,
    rationale,
  };
}
