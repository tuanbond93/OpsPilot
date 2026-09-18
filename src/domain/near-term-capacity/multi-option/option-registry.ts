import type { CurrentRisk, LeadFact } from "../loop";
import type { DecisionOption, RootCauseEvaluation } from "./types";
import { evaluateOptionCost } from "./evaluators/cost-evaluator";
import { evaluateOptionCapacity } from "./evaluators/capacity-evaluator";
import { evaluateOptionSla } from "./evaluators/sla-evaluator";

export const REQUESTED_INFORMATION_ITEMS = [
  "current available vehicle count",
  "vehicle class/capacity",
  "estimated arrival time",
  "station clearance throughput",
  "order SLA deadlines",
];

export function generateCandidateOptions(
  facts: CurrentRisk,
  lead: LeadFact | null,
  rootCause: RootCauseEvaluation
): DecisionOption[] {
  const options: DecisionOption[] = [];

  const isSmallBacklog =
    rootCause.category === "NO_MATERIAL_GAP" ||
    rootCause.category === "NO_MATERIAL_CAPACITY_GAP";

  // 1. NO_ACTION_MONITOR (Baseline operational continuity)
  const noActionCost = evaluateOptionCost("NO_ACTION_MONITOR", facts, lead);
  const noActionCapacity = evaluateOptionCapacity("NO_ACTION_MONITOR", facts, lead);
  const noActionSla = evaluateOptionSla("NO_ACTION_MONITOR", facts, lead, rootCause);

  options.push({
    option_id: "OPT_NO_ACTION_MONITOR",
    option_type: "NO_ACTION_MONITOR",
    description:
      "Giữ nguyên hiện trạng, xử lý bằng năng lực hiện có của trạm và kiểm tra lại tại checkpoint tiếp theo.",
    feasibility_status: "FEASIBLE",
    feasibility_reason: null,
    feasibility_evidence: "Hạ tầng trạm và nhân lực ca thường đang vận hành thực tế",
    infeasible_reason: null,
    economic: {
      status: "UNKNOWN",
      reason:
        "Chưa có biểu phí định mức hoặc chi phí phạt SLA để đối soát hiệu quả kinh tế so sánh (chi phí can thiệp phát sinh = 0 đ).",
    },
    economic_status: "UNKNOWN",
    economic_reason:
      "Chưa có biểu phí định mức hoặc chi phí phạt SLA để đối soát hiệu quả kinh tế so sánh (chi phí can thiệp phát sinh = 0 đ).",
    economic_evidence: "Thiếu biểu phí định mức và dữ liệu đối soát kinh tế",
    feasible: true,
    evidence_refs: facts.evidenceRefs || [],
    cost: noActionCost,
    capacity: noActionCapacity,
    sla: noActionSla,
    operational_effect: {
      description: "Không phát sinh chi phí vận chuyển ngoài; trạm tiếp tục xuất hàng theo ca thường.",
    },
    assumptions: ["Năng lực trạm hiện có duy trì ổn định"],
    unknowns: rootCause.unknowns,
    risks: [
      "Tồn kho có thể không giải tỏa kịp nếu phát sinh hàng lớn đột xuất hoặc năng suất ca thấp.",
    ],
    confidence: isSmallBacklog ? 0.6 : 0.4,
  });

  // 2. ADD_VEHICLE
  // Feasibility is CONDITIONALLY_FEASIBLE because vehicle availability, class, and schedule are unevidenced.
  // Economic justification is UNKNOWN: no governed rate matrix exists in the codebase.
  const addVehicleCost = evaluateOptionCost("ADD_VEHICLE", facts, lead);
  const addVehicleCapacity = evaluateOptionCapacity("ADD_VEHICLE", facts, lead);
  const addVehicleSla = evaluateOptionSla("ADD_VEHICLE", facts, lead, rootCause);

  options.push({
    option_id: "OPT_ADD_VEHICLE",
    option_type: "ADD_VEHICLE",
    description: "Điều động thêm phương tiện vận tải tăng cường để giải tỏa lượng hàng dồn ứ.",
    feasibility_status: "CONDITIONALLY_FEASIBLE",
    feasibility_reason: "Chưa xác nhận khả dụng xe, tải trọng và thời gian đến trạm",
    feasibility_evidence: "Mô hình vận tải xe ngoài có thể thực hiện nhưng chưa có dữ liệu định vị/lịch trình xe",
    infeasible_reason: null,
    economic: {
      status: "UNKNOWN",
      reason: "Chưa có biểu phí định mức xe ngoài hoặc ngưỡng kinh tế quy chuẩn để đối soát",
    },
    economic_status: "UNKNOWN",
    economic_reason: "Chưa có biểu phí định mức xe ngoài hoặc ngưỡng kinh tế quy chuẩn để đối soát",
    economic_evidence: "Thiếu biểu phí xe ngoài để tính toán hiệu quả kinh tế",
    // feasible boolean is true ONLY when feasibility_status === "FEASIBLE"
    feasible: false,
    evidence_refs: facts.evidenceRefs || [],
    cost: addVehicleCost,
    capacity: addVehicleCapacity,
    sla: addVehicleSla,
    operational_effect: {
      description: "Bổ sung xe để tăng năng lực xuất hàng ra khỏi trạm trong ca.",
    },
    assumptions: ["Có xe ngoài hoặc xe trung chuyển khả dụng trong khu vực"],
    unknowns: [
      "Chưa có biểu phí xe ngoài được chuẩn hóa",
      "Chưa có dữ liệu định vị và thời gian xe có thể đến trạm",
      "Chưa xác định tải trọng xe khả dụng",
    ],
    risks: [
      "Chi phí xe ngoài chưa xác định có thể gây lãng phí nếu tải gom thực tế không đủ",
    ],
    confidence: isSmallBacklog ? 0.3 : 0.4,
  });

  // 3. REALLOCATE_EXISTING_CAPACITY
  // Missing inter-warehouse route telemetry means feasibility is UNKNOWN, NOT INFEASIBLE.
  const reallocateCost = evaluateOptionCost("REALLOCATE_AVAILABLE_CAPACITY", facts, lead);
  const reallocateCapacity = evaluateOptionCapacity("REALLOCATE_AVAILABLE_CAPACITY", facts, lead);
  const reallocateSla = evaluateOptionSla("REALLOCATE_AVAILABLE_CAPACITY", facts, lead, rootCause);

  options.push({
    option_id: "OPT_REALLOCATE_EXISTING_CAPACITY",
    option_type: "REALLOCATE_AVAILABLE_CAPACITY",
    description: "Điều chuyển các tuyến xe hoặc chuyến xe trống lân cận để hỗ trợ giải tỏa trạm.",
    feasibility_status: "UNKNOWN",
    feasibility_reason:
      "Chưa có dữ liệu hành trình và tải xe liên trạm; thiếu căn cứ để kết luận khả thi hay không",
    feasibility_evidence: "Thiếu dữ liệu kết nối đội xe liên trạm",
    infeasible_reason: null,
    economic: {
      status: "UNKNOWN",
      reason: "Chưa có biểu phí hoặc dữ liệu định mức điều chuyển liên trạm",
    },
    economic_status: "UNKNOWN",
    economic_reason: "Chưa có biểu phí hoặc dữ liệu định mức điều chuyển liên trạm",
    economic_evidence: "Thiếu biểu phí điều chuyển liên trạm",
    feasible: false,
    evidence_refs: [],
    cost: reallocateCost,
    capacity: reallocateCapacity,
    sla: reallocateSla,
    operational_effect: {
      description: "Tối ưu hóa nguồn lực sẵn có mà không phát sinh thêm chi phí thuê ngoài.",
    },
    assumptions: ["Có xe rỗng hoặc xe thừa tải chạy qua trạm"],
    unknowns: ["Lịch trình và tải trọng thực tế của các tuyến xe lân cận"],
    risks: ["Ảnh hưởng đến thời gian xuất bến của tuyến bị điều chuyển"],
    confidence: 0.2,
  });

  // 4. ADD_MANPOWER
  // Missing manpower roster means feasibility is UNKNOWN, NOT INFEASIBLE.
  const manpowerCost = evaluateOptionCost("ADD_MANPOWER", facts, lead);
  const manpowerCapacity = evaluateOptionCapacity("ADD_MANPOWER", facts, lead);
  const manpowerSla = evaluateOptionSla("ADD_MANPOWER", facts, lead, rootCause);

  options.push({
    option_id: "OPT_ADD_MANPOWER",
    option_type: "ADD_MANPOWER",
    description: "Huy động thêm nhân sự/tài xế tại chỗ để đẩy nhanh khâu bốc xếp, phân loại.",
    feasibility_status: "UNKNOWN",
    feasibility_reason:
      "Chưa kết nối hệ thống chấm công và phân ca nhân sự; thiếu căn cứ để kết luận khả thi hay không",
    feasibility_evidence: "Thiếu dữ liệu nhân sự ca làm việc tại trạm",
    infeasible_reason: null,
    economic: {
      status: "UNKNOWN",
      reason: "Chưa có biểu phí hoặc định mức chi phí nhân sự tăng ca",
    },
    economic_status: "UNKNOWN",
    economic_reason: "Chưa có biểu phí hoặc định mức chi phí nhân sự tăng ca",
    economic_evidence: "Thiếu định mức chi phí nhân công tăng ca",
    feasible: false,
    evidence_refs: [],
    cost: manpowerCost,
    capacity: manpowerCapacity,
    sla: manpowerSla,
    operational_effect: {
      description: "Tăng tốc độ xử lý hàng tại kho.",
    },
    assumptions: ["Có nhân sự sẵn sàng tăng ca tại địa phương"],
    unknowns: ["Số lượng nhân sự đang làm việc và chi phí tăng ca"],
    risks: ["Không giải quyết được nếu nút thắt chính nằm ở phương tiện vận chuyển"],
    confidence: 0.2,
  });

  // 5. REQUEST_MORE_INFORMATION
  const requestCost = evaluateOptionCost("REQUEST_MORE_INFORMATION", facts, lead);
  const requestCapacity = evaluateOptionCapacity("REQUEST_MORE_INFORMATION", facts, lead);
  const requestSla = evaluateOptionSla("REQUEST_MORE_INFORMATION", facts, lead, rootCause);

  options.push({
    option_id: "OPT_REQUEST_MORE_INFORMATION",
    option_type: "REQUEST_MORE_INFORMATION",
    description: `Yêu cầu bổ sung dữ liệu vận hành còn thiếu: ${REQUESTED_INFORMATION_ITEMS.join(", ")}.`,
    feasibility_status: "FEASIBLE",
    feasibility_reason: null,
    feasibility_evidence: "Kênh tương tác Telegram và hệ thống thu thập facts đang hoạt động ổn định",
    infeasible_reason: null,
    economic: {
      status: "JUSTIFIED",
      reason:
        "Thu thập thông tin vận hành qua hệ thống không phát sinh chi phí can thiệp tăng thêm (không chứng minh phương án vận hành là tối ưu kinh tế).",
    },
    economic_status: "JUSTIFIED",
    economic_reason:
      "Thu thập thông tin vận hành qua hệ thống không phát sinh chi phí can thiệp tăng thêm (không chứng minh phương án vận hành là tối ưu kinh tế).",
    economic_evidence: "Chi phí gửi yêu cầu qua bot = 0 đ",
    feasible: true,
    evidence_refs: [],
    cost: requestCost,
    capacity: requestCapacity,
    sla: requestSla,
    operational_effect: {
      description: "Giữ an toàn hệ thống, tránh quyết định vội vàng khi thiếu dữ liệu nền tảng.",
    },
    assumptions: ["Lead/Manager có thể phản hồi nhanh qua Telegram"],
    unknowns: [],
    risks: ["Kéo dài thời gian ra quyết định nếu người dùng phản hồi chậm"],
    confidence: 0.8,
  });

  return options;
}
