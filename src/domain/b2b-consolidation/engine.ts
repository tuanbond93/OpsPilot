import type { ConsolidationAnalysis, ConsolidationAnalysisInput, ConsolidationOrder, ConsolidationReasonCode } from "./types";

function validDate(value: string) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function nonNegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function earliestDeadline(orders: ConsolidationOrder[]) {
  return orders.reduce<string | null>((earliest, order) => {
    if (!earliest || new Date(order.latestSafeDepartureAt).getTime() < new Date(earliest).getTime()) return order.latestSafeDepartureAt;
    return earliest;
  }, null);
}

export function analyzeB2bConsolidation(input: ConsolidationAnalysisInput): ConsolidationAnalysis {
  const reasons: ConsolidationReasonCode[] = [];
  const checks: string[] = [];
  const departureMs = validDate(input.trip.departureAt);
  const deadlines = input.orders.map((order) => validDate(order.latestSafeDepartureAt));
  const readyTimes = input.orders.map((order) => validDate(order.readyAt));
  const safeHoldUntil = earliestDeadline(input.orders);
  const canAssessCapacityKg = nonNegative(input.trip.capacityKg) && nonNegative(input.trip.bookedKg) && input.orders.every((order) => nonNegative(order.weightKg));
  const canAssessCapacityM3 = nonNegative(input.trip.capacityM3) && nonNegative(input.trip.bookedM3) && input.orders.every((order) => nonNegative(order.volumeM3));

  if (input.orders.length < 2) reasons.push("SINGLE_ORDER_NO_CONSOLIDATION_BENEFIT");
  if (!departureMs || deadlines.some((value) => value === null) || readyTimes.some((value) => value === null)) reasons.push("ROUTE_MISMATCH");
  if (departureMs && readyTimes.some((value) => value !== null && departureMs < value)) reasons.push("TRIP_DEPARTS_BEFORE_ORDER_READY");
  if (departureMs && deadlines.some((value) => value !== null && departureMs > value)) reasons.push("SLA_WINDOW_WOULD_BE_BREACHED");

  if (!canAssessCapacityKg && !canAssessCapacityM3) {
    reasons.push("CAPACITY_DATA_MISSING");
    checks.push("Bổ sung capacity và booked load theo kg hoặc m³ của chuyến.");
  } else {
    if (canAssessCapacityKg) {
      const requiredKg = input.orders.reduce((sum, order) => sum + (order.weightKg || 0), 0);
      if ((input.trip.capacityKg || 0) - (input.trip.bookedKg || 0) < requiredKg) reasons.push("CAPACITY_INSUFFICIENT");
    }
    if (canAssessCapacityM3) {
      const requiredM3 = input.orders.reduce((sum, order) => sum + (order.volumeM3 || 0), 0);
      if ((input.trip.capacityM3 || 0) - (input.trip.bookedM3 || 0) < requiredM3) reasons.push("CAPACITY_INSUFFICIENT");
    }
  }

  const hardStop = reasons.some((reason) => ["TRIP_DEPARTS_BEFORE_ORDER_READY", "SLA_WINDOW_WOULD_BE_BREACHED", "CAPACITY_INSUFFICIENT"].includes(reason));
  const missingData = reasons.includes("CAPACITY_DATA_MISSING") || reasons.includes("ORDER_LOAD_DATA_MISSING");
  const eligible = reasons.length === 0;
  if (eligible) reasons.push("ELIGIBLE_FOR_MANAGER_REVIEW");
  const verdict = eligible ? "ELIGIBLE_SHADOW" : hardStop ? "DISPATCH_NOW" : "HUMAN_INVESTIGATION_REQUIRED";

  if (!eligible) {
    checks.push("Manager phải xác minh SLA từng đơn và xác nhận phương án trước khi giữ đơn hoặc điều phối.");
    if (missingData) checks.push("Không được suy đoán tải trọng, capacity hoặc chi phí khi nguồn xe chưa cung cấp dữ liệu.");
  }

  return {
    mode: "SHADOW",
    verdict,
    reasonCodes: reasons,
    safeHoldUntil,
    trip: input.trip,
    orders: input.orders,
    options: [
      { option: "DISPATCH_NOW", enabled: true, approvalRequired: false, description: "Xuất theo quy trình hiện hành; không chờ ghép chuyến." },
      { option: "HOLD_FOR_CONSOLIDATION", enabled: eligible, approvalRequired: true, description: eligible ? "Chỉ là đề xuất SHADOW. Manager phải duyệt trước khi kho giữ đơn." : "Bị khóa vì SLA, năng lực hoặc dữ liệu chưa đủ." },
    ],
    requiredChecks: checks,
    financialImpact: { status: "NOT_EVALUATED", authority: "P15-B.1" },
  };
}
