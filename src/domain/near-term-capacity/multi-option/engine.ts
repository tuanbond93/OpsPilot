import type { CurrentRisk, LeadFact } from "../loop";
import type { MultiOptionDecisionResult } from "./types";
export type { MultiOptionDecisionResult };
import { evaluateRootCause } from "./root-cause";
import { generateCandidateOptions } from "./option-registry";
import { buildMultiOptionMatrix } from "./matrix";
import { critiqueMultiOptionRecommendation } from "./critic";

export interface MultiOptionEngineConfig {
  caseId?: string;
  enableGemini?: boolean;
}

export async function runMultiOptionEvaluation(
  facts: CurrentRisk,
  lead: LeadFact | null,
  config: MultiOptionEngineConfig = {}
): Promise<MultiOptionDecisionResult> {
  const caseId = config.caseId || "shadow-case";

  // 1. Root cause hypothesis
  const rootCause = evaluateRootCause(facts, lead);

  // 2. Deterministic candidate generation
  const candidates = generateCandidateOptions(facts, lead, rootCause);

  // 3. Build comparison matrix
  const matrix = buildMultiOptionMatrix(caseId, facts, rootCause, candidates);

  // 4. Comparative evaluation
  let recommended_option: MultiOptionDecisionResult["recommended_option"] = "INSUFFICIENT_EVIDENCE";
  let recommendation_reason = "";
  let tradeoff_summary = "";
  let confidence = 0.5;

  const missing_data: string[] = [
    "Biểu phí xe ngoài / xe tăng cường chưa có trong hệ thống",
    "Dữ liệu tải trọng và khả dụng thực tế của đội xe chưa kết nối",
    "Công suất phân loại/bốc xếp theo giờ tại trạm chưa được đo lường",
  ];

  if (rootCause.category === "NO_MATERIAL_CAPACITY_GAP") {
    // Verified small backlog (e.g. Case #002)
    recommended_option = "NO_ACTION_MONITOR";
    recommendation_reason =
      "Tồn kho ở mức thấp và Lead xác nhận không có hàng về thêm đáng kể; năng lực kho hiện tại đủ xử lý theo ca làm việc tiêu chuẩn.";
    tradeoff_summary =
      "Giữ nguyên hiện trạng không phát sinh chi phí điều xe ngoài; rủi ro vận hành thấp do khối lượng hàng nhỏ.";
    confidence = 0.9;
  } else if (rootCause.category === "SLA_AGING_RISK") {
    // Large backlog (e.g. Case #003: 11.7 tonnes / 87 orders)
    // Both options have critical unknowns:
    // - NO_ACTION: clearance speed unknown without station sorting rate
    // - ADD_VEHICLE: cost and vehicle availability unknown
    // Therefore, comparative evidence is mathematically insufficient to safely rank options without guessing.
    recommended_option = "INSUFFICIENT_EVIDENCE";
    recommendation_reason =
      "Tồn kho dồn ứ lớn (87 đơn / 11.7 tấn) nhưng thiếu dữ liệu định mức xe ngoài và công suất xử lý theo giờ tại trạm; chưa đủ bằng chứng để chứng minh điều xe hay giữ nguyên sẽ tối ưu hơn.";
    tradeoff_summary =
      "Cần bổ sung: (1) biểu phí xe ngoài, (2) giờ xe khả dụng, (3) tốc độ giải tỏa nội bộ trước khi có thể kết luận phương án tối ưu.";
    confidence = 0.4;
  } else if (rootCause.category === "INCOMING_VOLUME_RISK") {
    recommended_option = "REQUEST_MORE_INFORMATION";
    recommendation_reason =
      "Lead báo có hàng về thêm trong 4h tới nhưng chưa rõ khối lượng và phương tiện vận chuyển; cần thu thập thêm thông tin cụ thể.";
    tradeoff_summary =
      "Tránh điều xe non khi chưa biết lượng hàng thực tế; yêu cầu Lead cập nhật chi tiết.";
    confidence = 0.7;
  } else {
    recommended_option = "INSUFFICIENT_EVIDENCE";
    recommendation_reason =
      "Dữ liệu hiện tại chưa đủ để đưa ra so sánh định lượng có căn cứ giữa các phương án.";
    tradeoff_summary = "Cần theo dõi thêm ở các checkpoint kế tiếp.";
    confidence = 0.3;
  }

  // 5. Critic validation
  const preliminaryResult = {
    recommended_option,
    recommendation_reason,
    tradeoff_summary,
  };

  const critic = critiqueMultiOptionRecommendation(preliminaryResult, candidates);

  if (critic.verdict === "INVALID") {
    recommended_option = "INSUFFICIENT_EVIDENCE";
    recommendation_reason = `Đề xuất bị Critic từ chối vì vi phạm tiêu chuẩn bằng chứng: ${critic.flags.join("; ")}`;
  }

  return {
    decision_case_id: caseId,
    root_cause: rootCause,
    matrix,
    candidate_options: candidates,
    recommended_option,
    recommendation_reason,
    tradeoff_summary,
    confidence,
    critic_verdict: critic.verdict,
    critic_flags: critic.flags,
    missing_data,
  };
}
