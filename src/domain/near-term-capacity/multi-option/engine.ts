import type { CurrentRisk, LeadFact } from "../loop";
import type { MultiOptionDecisionResult } from "./types";
export type { MultiOptionDecisionResult };
import { evaluateRootCause } from "./root-cause";
import { generateCandidateOptions, resolveRequestedInformation } from "./option-registry";
import { buildMultiOptionMatrix } from "./matrix";
import { critiqueMultiOptionRecommendation } from "./critic";

import type { VehicleSourceAdapter } from "./sources/vehicle-source-adapter";
import { GovernedVehicleSourceAdapter } from "./sources/vehicle-source-adapter";

export interface MultiOptionEngineConfig {
  caseId?: string;
  enableGemini?: boolean;
  vehicleSourceAdapter?: VehicleSourceAdapter;
}

export async function runMultiOptionEvaluation(
  facts: CurrentRisk,
  lead: LeadFact | null,
  config: MultiOptionEngineConfig = {}
): Promise<MultiOptionDecisionResult> {
  const caseId = config.caseId || "shadow-case";
  const vehicleAdapter = config.vehicleSourceAdapter || new GovernedVehicleSourceAdapter();
  const vehicleEvidence = await vehicleAdapter.getVehicleEvidence(facts.warehouseId);

  // 1. Root cause hypothesis
  const rootCause = evaluateRootCause(facts, lead);

  // 2. Deterministic candidate generation
  const candidates = generateCandidateOptions(facts, lead, rootCause, vehicleEvidence);

  // 3. Build comparison matrix
  const matrix = buildMultiOptionMatrix(caseId, facts, rootCause, candidates);

  // 4. Comparative evaluation
  let recommended_option: MultiOptionDecisionResult["recommended_option"] = "INSUFFICIENT_EVIDENCE";
  let recommendation_reason = "";
  let tradeoff_summary = "";
  let confidence = 0.5;

  let requested_information: string[] | undefined = undefined;

  const hasRate = Boolean(
    (vehicleEvidence?.rates && vehicleEvidence.rates.some((r: any) => r.rate_vnd !== null && r.evidence_status !== "UNKNOWN")) ||
    (vehicleEvidence?.rate && vehicleEvidence.rate.rate_vnd !== null && vehicleEvidence.rate.evidence_status !== "UNKNOWN")
  );
  const hasVehicleClass = Boolean(
    vehicleEvidence?.capacity &&
    vehicleEvidence.capacity.usable_payload_kg !== null &&
    vehicleEvidence.capacity.evidence_status !== "UNKNOWN"
  );

  const missing_data: string[] = [];
  if (!hasRate) {
    missing_data.push("Biểu phí xe ngoài / xe tăng cường chưa có trong hệ thống");
  }
  if (!hasVehicleClass) {
    missing_data.push("Thông số tải trọng xe chuẩn hóa chưa có trong hệ thống");
  }
  missing_data.push("Dữ liệu tải trọng và khả dụng thực tế của đội xe chưa kết nối");
  missing_data.push("Công suất phân loại/bốc xếp theo giờ tại trạm chưa được đo lường");

  if (
    rootCause.category === "NO_MATERIAL_GAP" ||
    rootCause.category === "NO_MATERIAL_CAPACITY_GAP"
  ) {
    // Verified small backlog (e.g. Case #002)
    recommended_option = "NO_ACTION_MONITOR";
    recommendation_reason =
      "Tồn kho quan sát ở mức thấp và Lead xác nhận không có hàng về thêm đáng kể; duy trì hiện trạng không phát sinh chi phí can thiệp tăng thêm.";
    tradeoff_summary =
      "Duy trì năng lực hiện có với chi phí can thiệp phát sinh = 0 đ; hiệu quả kinh tế so sánh ở mức UNKNOWN do hệ thống chưa có biểu phí định mức quy chuẩn.";
    confidence = 0.55;
  } else if (
    rootCause.category === "CAPACITY_CAUSE_UNKNOWN" ||
    rootCause.category === "BACKLOG_ACCUMULATION" ||
    rootCause.category === "BACKLOG_AGING_RISK"
  ) {
    // Large backlog with missing telemetry (e.g. Case #003: 11.7 tonnes / 87 orders)
    // Feasible options cannot be safely ranked between NO_ACTION and ADD_VEHICLE
    // without fleet availability, cost matrix, and throughput.
    // REQUEST_MORE_INFORMATION is the first-class operational recommendation.
    recommended_option = "REQUEST_MORE_INFORMATION";
    recommendation_reason =
      "Tồn kho dồn ứ lớn nhưng trạm thiếu các dữ liệu nền tảng về đội xe, định mức chi phí và công suất giải tỏa; cần yêu cầu bổ sung thông tin vận hành trước khi quyết định can thiệp nguồn lực.";
    if (hasVehicleClass && hasRate) {
      tradeoff_summary =
        "Đã có biểu phí và tải trọng quy chuẩn (TRUCK_1_9T, 1600 kg); cần bổ sung: (1) số lượng xe khả dụng, (2) khả dụng nhà cung cấp, (3) giờ xe đến sớm nhất, (4) năng suất trạm, (5) hạn SLA đơn hàng trước khi có thể kết luận phương án tối ưu.";
    } else {
      tradeoff_summary =
        "Cần bổ sung: (1) số lượng xe khả dụng, (2) tải trọng xe, (3) giờ xe đến, (4) năng suất trạm, (5) hạn SLA đơn hàng trước khi có thể kết luận phương án tối ưu.";
    }
    confidence = 0.75;
    requested_information = resolveRequestedInformation(vehicleEvidence);
  } else if (rootCause.category === "INCOMING_VOLUME_RISK") {
    recommended_option = "REQUEST_MORE_INFORMATION";
    recommendation_reason =
      "Lead báo có hàng về thêm trong 4h tới nhưng chưa rõ khối lượng và phương tiện vận chuyển; cần thu thập thêm thông tin cụ thể.";
    tradeoff_summary =
      "Tránh điều xe non khi chưa biết lượng hàng thực tế; yêu cầu Lead cập nhật chi tiết.";
    confidence = 0.7;
    requested_information = [
      "expected incoming freight kg",
      "freight arrival window",
      "vehicle dispatch readiness",
    ];
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
    root_cause: rootCause,
  };

  const critic = critiqueMultiOptionRecommendation(preliminaryResult, candidates);

  if (critic.verdict === "INVALID") {
    recommended_option = "INSUFFICIENT_EVIDENCE";
    recommendation_reason = `Đề xuất bị Critic từ chối vì vi phạm tiêu chuẩn bằng chứng: ${critic.flags.join("; ")}`;
  }

  const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

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
    requested_information,
    capacity_gap_before: addVehicle?.capacity.capacity_gap_before || "UNKNOWN",
    capacity_gap_after: addVehicle?.capacity.capacity_gap_after || "UNKNOWN",
    projected_incremental_cost_difference: addVehicle?.projected_cost_difference_display || "UNKNOWN",
  };
}
