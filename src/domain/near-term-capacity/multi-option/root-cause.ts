import type { CurrentRisk, LeadFact } from "../loop";
import type { RootCauseCategory, RootCauseEvaluation } from "./types";

export function evaluateRootCause(
  facts: CurrentRisk,
  lead: LeadFact | null
): RootCauseEvaluation {
  const unknowns: string[] = [
    "Năng lực và lịch trình xe tại trạm chưa có dữ liệu",
    "Công suất phân loại/bốc xếp theo giờ tại trạm chưa có dữ liệu",
    "Hạn SLA giao hàng cụ thể từng đơn chưa có dữ liệu",
  ];

  const evidence: string[] = [
    `Tồn kho hiện tại: ${facts.currentOrders ?? "Chưa rõ"} đơn / ${facts.currentKg != null ? `${facts.currentKg} kg` : "Chưa có dữ liệu khối lượng"}`,
  ];

  if (facts.riskSignals?.length) {
    evidence.push(`Tín hiệu rủi ro: ${facts.riskSignals.join(", ")}`);
  }

  if (lead) {
    evidence.push(`Phản hồi từ Lead: ${lead.incoming}`);
    if (lead.expectedIncomingKg != null) {
      evidence.push(`Khối lượng hàng về dự kiến: ${lead.expectedIncomingKg} kg`);
    }
    if (lead.expectedIncomingAt) {
      evidence.push(`ETA hàng về: ${lead.expectedIncomingAt}`);
    }
  } else {
    unknowns.push("Chưa có phản hồi facts từ Lead kho");
  }

  // 1. Incoming freight surge reported by Lead
  if (lead?.incoming === "CONFIRMED_ETA" || lead?.incoming === "UNCERTAIN_ETA") {
    return {
      category: "INCOMING_VOLUME_RISK",
      confidence: lead.incoming === "CONFIRMED_ETA" ? 0.75 : 0.6,
      evidence,
      unknowns,
      reasoning:
        "Lead trạm xác nhận sắp có thêm hàng về trong cửa sổ 4 giờ tới; có nguy cơ tích tụ tồn kho nếu không chuẩn bị trước nguồn lực.",
    };
  }

  // 2. Verified small backlog with no incoming freight (e.g. Case #002)
  const isSmallBacklog =
    facts.currentKg != null &&
    facts.currentKg < 500 &&
    (facts.currentOrders == null || facts.currentOrders < 20);

  if (isSmallBacklog && lead?.incoming === "NO_SIGNIFICANT_INCOMING") {
    return {
      category: "NO_MATERIAL_GAP",
      confidence: 0.85,
      evidence,
      unknowns,
      reasoning:
        "Tồn kho ở mức thấp và Lead xác nhận không có hàng về thêm đáng kể; không có khoảng trống năng lực trọng yếu.",
    };
  }

  // 3. Significant backlog present at station without incoming surge (e.g. Case #003)
  const isLargeBacklog =
    (facts.currentKg != null && facts.currentKg >= 3000) ||
    (facts.currentOrders != null && facts.currentOrders >= 40);

  if (isLargeBacklog && lead?.incoming === "NO_SIGNIFICANT_INCOMING") {
    return {
      category: "CAPACITY_CAUSE_UNKNOWN",
      confidence: 0.4, // Low confidence: cannot attribute cause without fleet/throughput telemetry
      evidence,
      unknowns,
      reasoning:
        "Tồn kho khối lượng lớn dồn ứ tại trạm (tích lũy tồn kho); tuy nhiên nguyên nhân do thiếu xe, trạm phân loại chậm, hay hàng chờ gom chưa thể quy kết do thiếu dữ liệu đội xe và năng suất trạm.",
    };
  }

  // 4. Default / Unresolved
  return {
    category: "UNKNOWN",
    confidence: 0.25,
    evidence,
    unknowns,
    reasoning:
      "Dữ liệu hiện tại chưa đủ cơ sở để xác định chính xác nguyên nhân gốc rễ (thiếu dữ liệu xe, nhân lực và đo lường SLA).",
  };
}
