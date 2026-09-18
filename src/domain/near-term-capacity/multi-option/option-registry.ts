import type { CurrentRisk, LeadFact } from "../loop";
import type { DecisionOption, EconomicStatus, FeasibilityStatus, RootCauseEvaluation } from "./types";
import { evaluateOptionCost, computeProjectedCostDifference } from "./evaluators/cost-evaluator";
import { evaluateOptionCapacity } from "./evaluators/capacity-evaluator";
import { evaluateOptionSla } from "./evaluators/sla-evaluator";
import type { VehicleEconomicsAndCapacityResult } from "./sources/vehicle-source-adapter";

export const REQUESTED_INFORMATION_ITEMS = [
  "current available vehicle count",
  "vehicle class/capacity",
  "estimated arrival time",
  "station clearance throughput",
  "order SLA deadlines",
];

export function resolveRequestedInformation(
  vehicleEvidence?: VehicleEconomicsAndCapacityResult | null
): string[] {
  const items: string[] = [];

  const hasVehicleClass = Boolean(
    vehicleEvidence?.capacity &&
    vehicleEvidence.capacity.usable_payload_kg !== null &&
    vehicleEvidence.capacity.evidence_status !== "UNKNOWN"
  );
  if (!hasVehicleClass) {
    items.push("vehicle class/capacity");
  }

  const hasRate = Boolean(
    (vehicleEvidence?.rates && vehicleEvidence.rates.some((r) => r.rate_vnd !== null && r.evidence_status !== "UNKNOWN")) ||
    (vehicleEvidence?.rate && vehicleEvidence.rate.rate_vnd !== null && vehicleEvidence.rate.evidence_status !== "UNKNOWN")
  );
  if (!hasRate) {
    items.push("vehicle monthly rate");
  }

  const hasAvailability = Boolean(
    (vehicleEvidence?.availabilities &&
      vehicleEvidence.availabilities.some(
        (a) => a.available !== null && a.evidence_status !== "UNKNOWN"
      )) ||
    (vehicleEvidence?.availability &&
      vehicleEvidence.availability.available !== null &&
      vehicleEvidence.availability.evidence_status !== "UNKNOWN")
  );
  if (!hasAvailability) {
    items.push("currently available vehicle count");
    items.push("current available vehicle count");
    items.push("supplier/vehicle availability");
    items.push("earliest available time");
    items.push("estimated arrival time");
  }

  items.push("station clearance throughput");
  items.push("order SLA deadlines");
  items.push("order-level SLA deadlines");

  return items;
}

export function generateCandidateOptions(
  facts: CurrentRisk,
  lead: LeadFact | null,
  rootCause: RootCauseEvaluation,
  vehicleEvidence?: VehicleEconomicsAndCapacityResult | null
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
    projected_incremental_cost_difference: 0,
    projected_cost_difference_display: "0 đ (Baseline)",
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
  const addVehicleCapacity = evaluateOptionCapacity("ADD_VEHICLE", facts, lead, vehicleEvidence?.capacity);
  const addVehicleSla = evaluateOptionSla("ADD_VEHICLE", facts, lead, rootCause);

  const candidateRates =
    vehicleEvidence?.rates && vehicleEvidence.rates.length > 0
      ? vehicleEvidence.rates
      : vehicleEvidence?.rate
      ? [vehicleEvidence.rate]
      : [null];

  for (const rateItem of candidateRates) {
    const addVehicleCost = evaluateOptionCost("ADD_VEHICLE", facts, lead, rateItem);
    const costDiff = computeProjectedCostDifference(addVehicleCost, noActionCost);

    const supplierName = rateItem?.supplier_name;

    // Supplier-specific availability lookup:
    // Match by supplier_name in availabilities, or fallback to single availability if no supplier specified
    const matchedAvailability =
      vehicleEvidence?.availabilities?.find(
        (a) =>
          a.supplier_name &&
          supplierName &&
          a.supplier_name.trim().toUpperCase() === supplierName.trim().toUpperCase()
      ) ||
      (vehicleEvidence?.availability?.supplier_name &&
       supplierName &&
       vehicleEvidence.availability.supplier_name.trim().toUpperCase() === supplierName.trim().toUpperCase()
        ? vehicleEvidence.availability
        : null) ||
      (!supplierName ? vehicleEvidence?.availability : null);

    const currentAvailability = matchedAvailability || {
      warehouse_id: facts.warehouseId,
      vehicle_id: null,
      vehicle_class: rateItem?.vehicle_class || "TRUCK_1_9T",
      available: null,
      availability_status: "UNKNOWN" as const,
      available_at: null,
      remaining_capacity_kg: null,
      source_ref: null,
      captured_at: null,
      evidence_status: "UNKNOWN" as const,
      supplier_name: supplierName || null,
    };

    let addVehicleFeasibility: FeasibilityStatus = "CONDITIONALLY_FEASIBLE";
    let addVehicleFeasibilityReason: string | null = "Chưa xác nhận khả dụng xe, tải trọng và thời gian đến trạm";
    let addVehicleFeasibilityEvidence: string | null = "Mô hình vận tải xe ngoài có thể thực hiện nhưng chưa có dữ liệu định vị/lịch trình xe";

    const availStatus = currentAvailability.availability_status || "UNKNOWN";

    if (availStatus === "UNAVAILABLE") {
      addVehicleFeasibility = "INFEASIBLE";
      addVehicleFeasibilityReason = "Không có phương tiện vận tải khả dụng tại trạm";
      addVehicleFeasibilityEvidence = `Nguồn dữ liệu xác nhận xe không khả dụng (ref: ${currentAvailability.source_ref || "fleet_roster"})`;
    } else if (availStatus === "SCHEDULED_AVAILABLE") {
      addVehicleFeasibility = "CONDITIONALLY_FEASIBLE";
      addVehicleFeasibilityReason = `Phương tiện dự kiến khả dụng lúc ${currentAvailability.earliest_available_at || currentAvailability.available_at}; chưa sẵn sàng điều động ngay`;
      addVehicleFeasibilityEvidence = `Phương tiện đang được lên lịch (dự kiến đến ${currentAvailability.earliest_available_at || currentAvailability.available_at})`;
    } else if (availStatus === "AVAILABLE_NOW") {
      if (
        currentAvailability.evidence_status === "AUTHORIZED_OPERATIONAL_FACT" ||
        currentAvailability.evidence_status === "SYSTEM_AUTHORIZED_IMPORT" ||
        currentAvailability.evidence_status === "GOVERNED" ||
        currentAvailability.evidence_status === "MEASURED"
      ) {
        addVehicleFeasibility = "FEASIBLE";
        addVehicleFeasibilityReason = null;
        addVehicleFeasibilityEvidence = `Phương tiện ${supplierName ? `${supplierName} ` : ""}${currentAvailability.vehicle_id || currentAvailability.vehicle_class || "được chỉ định"} sẵn sàng điều động ngay (ref: ${currentAvailability.source_ref})`;
      } else {
        addVehicleFeasibility = "CONDITIONALLY_FEASIBLE";
        addVehicleFeasibilityReason = "Khả dụng xe chưa được xác nhận bởi nguồn dữ liệu chính thức";
        addVehicleFeasibilityEvidence = `Dữ liệu khả dụng mang tính mô hình (ref: ${currentAvailability.source_ref})`;
      }
    } else {
      addVehicleFeasibility = "CONDITIONALLY_FEASIBLE";
      addVehicleFeasibilityReason = "Chưa xác nhận khả dụng xe hoặc giờ xe đến sớm nhất; nguồn dữ liệu khả dụng chưa kết nối";
      addVehicleFeasibilityEvidence = `Thiếu dữ liệu khả dụng đội xe từ ${supplierName || "đơn vị vận tải"}`;
    }

    const availabilityStatusDisplay = availStatus;

    let addVehicleEconomicStatus: EconomicStatus = "UNKNOWN";
    let addVehicleEconomicReason: string | null = "Chưa có biểu phí định mức xe ngoài hoặc ngưỡng kinh tế quy chuẩn để đối soát";
    let addVehicleEconomicEvidence: string | null = "Thiếu biểu phí xe ngoài để tính toán hiệu quả kinh tế";

    if (
      addVehicleCost.evidence_status === "UNKNOWN" ||
      addVehicleCost.incremental_cost_vnd === null ||
      addVehicleCapacity.status === "UNKNOWN" ||
      addVehicleCapacity.added_kg === null
    ) {
      addVehicleEconomicStatus = "UNKNOWN";
      addVehicleEconomicReason = "Chưa có biểu phí định mức hoặc tải trọng xe chuẩn hóa để đối soát hiệu quả kinh tế";
      addVehicleEconomicEvidence = "Thiếu dữ liệu kinh tế/năng lực quy chuẩn";
    } else {
      const backlogKg = facts.currentKg ?? 0;
      if (backlogKg <= 0) {
        addVehicleEconomicStatus = "NOT_JUSTIFIED";
        addVehicleEconomicReason = `Chi phí ${addVehicleCost.incremental_cost_vnd.toLocaleString("vi-VN")} đ phát sinh không cần thiết vì tồn kho (${backlogKg} kg) không có khoảng trống năng lực đáng kể.`;
        addVehicleEconomicEvidence = `Biểu phí ${addVehicleCost.source}: chi phí vượt quá nhu cầu giải tỏa`;
      } else {
        addVehicleEconomicStatus = "JUSTIFIED";
        addVehicleEconomicReason = `Chi phí can thiệp dự kiến ${addVehicleCost.incremental_cost_vnd.toLocaleString("vi-VN")} đ bù đắp khoảng trống năng lực (${addVehicleCapacity.added_kg} kg bổ sung) theo biểu phí định mức đã ban hành.`;
        addVehicleEconomicEvidence = `Căn cứ biểu phí ${addVehicleCost.source} và tải trọng quy chuẩn ${addVehicleCapacity.status}`;
      }
    }

    const supplierSlug = rateItem?.supplier_name
      ? `_${rateItem.supplier_name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/_+/g, "_")}`
      : "";
    const supplierLabel = rateItem?.supplier_name ? ` (${rateItem.supplier_name})` : "";

    options.push({
      option_id: supplierSlug ? `OPT_ADD_VEHICLE${supplierSlug}` : "OPT_ADD_VEHICLE",
      option_type: "ADD_VEHICLE",
      description: `Điều động thêm phương tiện vận tải tăng cường${supplierLabel} để giải tỏa lượng hàng dồn ứ.`,
      feasibility_status: addVehicleFeasibility,
      feasibility_reason: addVehicleFeasibilityReason,
      feasibility_evidence: addVehicleFeasibilityEvidence,
      infeasible_reason: addVehicleFeasibility === "INFEASIBLE" ? addVehicleFeasibilityReason : null,
      economic: {
        status: addVehicleEconomicStatus,
        reason: addVehicleEconomicReason,
      },
      economic_status: addVehicleEconomicStatus,
      economic_reason: addVehicleEconomicReason,
      economic_evidence: addVehicleEconomicEvidence,
      feasible: addVehicleFeasibility === "FEASIBLE",
      availability: availabilityStatusDisplay,
      evidence_refs: facts.evidenceRefs || [],
      cost: addVehicleCost,
      capacity: addVehicleCapacity,
      sla: addVehicleSla,
      projected_incremental_cost_difference: costDiff.difference_vnd,
      projected_cost_difference_display: costDiff.display,
      operational_effect: {
        description: "Bổ sung xe để tăng năng lực xuất hàng ra khỏi trạm trong ca.",
      },
      assumptions: ["Có xe ngoài hoặc xe trung chuyển khả dụng trong khu vực"],
      unknowns: [
        ...(addVehicleCost.evidence_status === "UNKNOWN" ? ["Chưa có biểu phí xe ngoài được chuẩn hóa"] : []),
        ...(currentAvailability.available !== true || currentAvailability.evidence_status === "UNKNOWN"
          ? ["Chưa có dữ liệu định vị và thời gian xe có thể đến trạm"]
          : []),
        ...(addVehicleCapacity.status === "UNKNOWN" ? ["Chưa xác định tải trọng xe khả dụng"] : []),
      ],
      risks: [
        "Chi phí xe ngoài chưa xác định có thể gây lãng phí nếu tải gom thực tế không đủ",
      ],
      confidence: isSmallBacklog ? 0.3 : 0.4,
    });
  }

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

  const requestedItems = resolveRequestedInformation(vehicleEvidence);

  options.push({
    option_id: "OPT_REQUEST_MORE_INFORMATION",
    option_type: "REQUEST_MORE_INFORMATION",
    description: `Yêu cầu bổ sung dữ liệu vận hành còn thiếu: ${requestedItems.join(", ")}.`,
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
