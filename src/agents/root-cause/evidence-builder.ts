import type { DeterministicContext } from "./context-builder";

export type EvidenceCode =
  | "CURRENT_AFFECTED_COUNT"
  | "PREVIOUS_AFFECTED_COUNT"
  | "COUNT_CHANGE_ABSOLUTE"
  | "COUNT_CHANGE_PERCENT"
  | "TREND_INCREASING"
  | "TREND_DECREASING"
  | "TREND_STABLE"
  | "HISTORY_INSUFFICIENT"
  | "MAXIMUM_AGE_HOURS"
  | "AVERAGE_AGE_HOURS"
  | "INCIDENT_DURATION_HOURS"
  | "PEAK_AFFECTED_COUNT"
  | "NO_STAFFING_DATA"
  | "NO_VEHICLE_DATA"
  | "NO_ROUTE_CAPACITY_DATA"
  | "EXCEPTION_DATA_AVAILABLE"
  | "EXCEPTION_DATA_UNAVAILABLE"
  | "PICKUP_DELAY_DIRECT"
  | "PICKUP_JOURNEY_DATA_MISSING"
  | "CPTT_DOCUMENT_RETURN_PATTERN"
  | "GHN_MORNING_COT_POLICY"
  | "SIMILAR_CASE_GROUPING_POLICY";

export interface EvidenceItem {
  code: EvidenceCode;
  value: string | number;
  statement: string;
}

/**
 * Converts deterministic context metrics into verified evidence statements
 */
export function buildDeterministicEvidence(context: DeterministicContext): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  // 1. Current affected count
  evidence.push({
    code: "CURRENT_AFFECTED_COUNT",
    value: context.currentAffectedCount,
    statement: `Số lượng đơn hàng bị ảnh hưởng hiện tại là ${context.currentAffectedCount} đơn.`,
  });

  if (context.pickupDelayedOrderCount > 0 && context.maximumPickupWaitHours !== null) {
    evidence.push({ code: "PICKUP_DELAY_DIRECT", value: `${context.maximumPickupWaitHours}h`, statement: `Có ${context.pickupDelayedOrderCount} đơn có bằng chứng trực tiếp chậm đầu lấy; thời gian từ tạo đến hoàn tất lấy cao nhất ${context.maximumPickupWaitHours} giờ. Mã mẫu: ${context.pickupDelayOrderCodes.join(", ") || "không có"}.` });
  } else {
    evidence.push({ code: "PICKUP_JOURNEY_DATA_MISSING", value: `${context.pickupJourneyCoveragePercent}%`, statement: `Chưa có đủ timestamp tạo đơn và hoàn tất lấy để kết luận chậm đầu lấy. Mức bao phủ dữ liệu hành trình: ${context.pickupJourneyCoveragePercent}%.` });
  }

  if (context.cpttSampleOrderCodes.length > 0) {
    evidence.push({ code: "CPTT_DOCUMENT_RETURN_PATTERN", value: context.cpttSampleOrderCodes.length, statement: `Có ${context.cpttSampleOrderCodes.length} mã mẫu đuôi _CPTT (${context.cpttSampleOrderCodes.join(", ")}); theo playbook đây là chứng từ thu hồi và phải kiểm tra riêng trách nhiệm xuất tại từng kho.` });
  }
  evidence.push({ code: "GHN_MORNING_COT_POLICY", value: context.ghnMorningCotHour, statement: `Quy tắc vận hành do người phụ trách xác nhận: các kho GHN có COT luân chuyển lúc ${String(context.ghnMorningCotHour).padStart(2, "0")}:00 sáng; đơn đã nhập trước COT nhưng còn tồn sau khung này cần được kiểm tra nguyên nhân chưa xuất.` });
  evidence.push({ code: "SIMILAR_CASE_GROUPING_POLICY", value: "active", statement: context.groupingPolicy });

  // 2. History & Trend evidence
  if (context.historyPointCount >= 2) {
    evidence.push({
      code: "PREVIOUS_AFFECTED_COUNT",
      value: context.previousAffectedCount,
      statement: `Số lượng đơn hàng bị ảnh hưởng ở kỳ trước là ${context.previousAffectedCount} đơn.`,
    });

    evidence.push({
      code: "COUNT_CHANGE_ABSOLUTE",
      value: context.changeAbsolute,
      statement: `Thay đổi tuyệt đối về số lượng đơn hàng: ${context.changeAbsolute > 0 ? "+" : ""}${context.changeAbsolute} đơn.`,
    });

    evidence.push({
      code: "COUNT_CHANGE_PERCENT",
      value: `${context.changePercent}%`,
      statement: `Tỷ lệ thay đổi số lượng đơn hàng: ${context.changePercent > 0 ? "+" : ""}${context.changePercent}%.`,
    });

    if (context.trendDirection === "increasing") {
      evidence.push({
        code: "TREND_INCREASING",
        value: "increasing",
        statement: `Xu hướng sự cố đang gia tăng (+${context.changePercent}%).`,
      });
    } else if (context.trendDirection === "decreasing") {
      evidence.push({
        code: "TREND_DECREASING",
        value: "decreasing",
        statement: `Xu hướng sự cố đang giảm bớt (${context.changePercent}%).`,
      });
    } else {
      evidence.push({
        code: "TREND_STABLE",
        value: "stable",
        statement: `Xu hướng sự cố duy trì ổn định.`,
      });
    }
  } else {
    evidence.push({
      code: "HISTORY_INSUFFICIENT",
      value: context.historyPointCount,
      statement: `Dữ liệu lịch sử chưa đủ (${context.historyPointCount} điểm dữ liệu), chưa thể kết luận xu hướng dài hạn.`,
    });
  }

  // 3. Age evidence
  if (context.maximumAgeHours !== null) {
    evidence.push({
      code: "MAXIMUM_AGE_HOURS",
      value: `${context.maximumAgeHours}h`,
      statement: `Thời gian tồn đọng tối đa của đơn hàng là ${context.maximumAgeHours} giờ.`,
    });
  }

  if (context.averageAgeHours !== null) {
    evidence.push({
      code: "AVERAGE_AGE_HOURS",
      value: `${context.averageAgeHours}h`,
      statement: `Thời gian tồn đọng trung bình của đơn hàng là ${context.averageAgeHours} giờ.`,
    });
  }

  // 4. Incident Duration
  evidence.push({
    code: "INCIDENT_DURATION_HOURS",
    value: `${context.incidentDurationHours}h`,
    statement: `Sự cố đã kéo dài tổng cộng ${context.incidentDurationHours} giờ kể từ khi phát hiện.`,
  });

  // 5. Peak Count
  evidence.push({
    code: "PEAK_AFFECTED_COUNT",
    value: context.peakAffectedCount,
    statement: `Mức tồn đọng đỉnh điểm recorded được là ${context.peakAffectedCount} đơn.`,
  });

  // 6. Explicit Missing Data Boundaries (Preventing LLM Hallucination)
  evidence.push({
    code: "NO_STAFFING_DATA",
    value: "none",
    statement: "Không có dữ liệu về nhân sự / ca trực kho trong hệ thống.",
  });

  evidence.push({
    code: "NO_VEHICLE_DATA",
    value: "none",
    statement: "Không có dữ liệu về phương tiện / tài xế vận chuyển trong hệ thống.",
  });

  evidence.push({
    code: "NO_ROUTE_CAPACITY_DATA",
    value: "none",
    statement: "Không có dữ liệu về tải trọng tuyến đường trong hệ thống.",
  });

  evidence.push({
    code: "EXCEPTION_DATA_AVAILABLE",
    value: "active",
    statement: "Các đơn hàng có ngoại lệ (khách hẹn, hư hỏng, thiếu chứng từ) đã được hệ thống loại trừ tự động.",
  });

  return evidence;
}
