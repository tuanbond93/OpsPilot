import {
  formatSemanticOrders,
  formatSemanticWeight,
  type AiRecommendation,
  type CurrentRisk,
  type DecisionContext,
  type LeadFact,
} from "@/domain/near-term-capacity";

function escape(value: string): string { return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!); }

/** Fact-only prompt: Lead is never asked to choose an operational action. */
export function formatNearTermFactRequest(facts: CurrentRisk, windowMinutes: number) {
  const codes = Array.isArray(facts.orderCodes) ? facts.orderCodes.filter((code): code is string => typeof code === "string" && Boolean(code.trim())) : [];
  const shownCodes = codes.slice(0, 5);
  const remaining = Math.max(0, codes.length - shownCodes.length);
  const orderLines = shownCodes.length ? shownCodes.map((code) => `  - ${escape(code)}`) : ["  - Chưa có dữ liệu mã đơn"];
  if (remaining > 0) orderLines.push(`  - + ${remaining} đơn khác`);
  const riskReason = facts.currentKg == null
    ? "Thiếu dữ liệu khối lượng; cần Lead xác nhận thêm để đánh giá năng lực xử lý"
    : "Tồn kho đang có đơn cần xử lý; OpsPilot cần kiểm tra nguy cơ không xử lý hết hàng trong 4 giờ tới";
  return [
    "🟠 OPSPILOT — CẦN XÁC NHẬN NĂNG LỰC XỬ LÝ", "", `Kho: ${escape(facts.warehouseName)}`, "",
    "📦 TÌNH HÌNH HIỆN TẠI", `• Đang tồn: ${formatSemanticOrders(facts.currentOrders)}`, `• Tổng khối lượng: ${formatSemanticWeight(facts.currentKg)}`, "• Đơn liên quan:", ...orderLines, "",
    "⚠️ RỦI RO OPSPILOT PHÁT HIỆN", `• ${riskReason}`, ...(facts.supportingChange ? [`• ${escape(facts.supportingChange)}`] : []), "",
    "💡 OPSPILOT CẦN LEAD XÁC NHẬN", `Trong ${Math.round(windowMinutes / 60)} giờ tới, kho có dự kiến nhận thêm lượng hàng đáng kể không?`,
    "Thông tin này được dùng để đánh giá kho có nguy cơ không xử lý hết hàng trong thời gian tới hay không.",
  ].join("\n");
}

export const nearTermFactButtons = [
  ["Có — biết khá chắc giờ hàng về", "CONFIRMED_ETA"], ["Có — nhưng chưa chắc giờ hàng về", "UNCERTAIN_ETA"],
  ["Không có thêm đáng kể", "NO_SIGNIFICANT_INCOMING"], ["Chưa xác định", "UNKNOWN"],
] as const;

export type NearTermFactAnswer = typeof nearTermFactButtons[number][1];
const compactAnswerCodes: Record<NearTermFactAnswer, string> = {
  CONFIRMED_ETA: "C",
  UNCERTAIN_ETA: "U",
  NO_SIGNIFICANT_INCOMING: "N",
  UNKNOWN: "X",
};
const answerByCompactCode = Object.fromEntries(Object.entries(compactAnswerCodes).map(([answer, code]) => [code, answer])) as Record<string, NearTermFactAnswer | undefined>;
const legacyAnswerPattern = "CONFIRMED_ETA|UNCERTAIN_ETA|NO_SIGNIFICANT_INCOMING|UNKNOWN";
export function buildNearTermFactCallbackData(caseId: string, answer: NearTermFactAnswer) {
  const value = `opspcap:${caseId}:${compactAnswerCodes[answer]}`;
  if (!/^opspcap:[0-9a-f-]{36}:[CUNX]$/i.test(value) || Buffer.byteLength(value) > 64) throw new Error("INVALID_NEAR_TERM_FACT_CALLBACK");
  return value;
}
export function parseNearTermFactCallbackData(value: unknown): { caseId: string; answer: NearTermFactAnswer } | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > 64) return null;
  const compact = /^opspcap:([0-9a-f-]{36}):([CUNX])$/i.exec(value);
  if (compact) {
    const answer = answerByCompactCode[compact[2].toUpperCase()];
    return answer ? { caseId: compact[1].toLowerCase(), answer } : null;
  }
  const legacy = new RegExp(`^opspcap:([0-9a-f-]{36}):(${legacyAnswerPattern})$`, "i").exec(value);
  return legacy ? { caseId: legacy[1].toLowerCase(), answer: legacy[2].toUpperCase() as NearTermFactAnswer } : null;
}
export function formatNearTermDetailRequest() {
  return "Vui lòng reply đúng 1 dòng: KG=<số>; ETA=<ISO-8601>; TYPE=B2B|ECOM|MIXED. Chỉ cung cấp facts, không chọn phương án xử lý.";
}

/** Manager sees exactly one validated final action; unknown money stays explicit. */
export function formatNearTermManagerCard(warehouseName: string, facts: CurrentRisk, lead: LeadFact, context: DecisionContext, decision: AiRecommendation) {
  const money = decision.estimated_cost_vnd == null && decision.estimated_saving_vnd == null
    ? "Chưa đủ dữ liệu xác minh chi phí"
    : `Chi phí: ${decision.estimated_cost_vnd ?? "—"}; tiết kiệm: ${decision.estimated_saving_vnd ?? "—"}`;
  return [
    "🧠 OPSPILOT — QUYẾT ĐỊNH CẦN PHÊ DUYỆT", "", `📍 Kho: ${escape(warehouseName)}`, "",
    "⚠️ Vấn đề vận hành", escape(decision.current_risk), `• Hiện tại: ${formatSemanticWeight(facts.currentKg)} / ${formatSemanticOrders(facts.currentOrders)}`,
    `• Facts từ Lead: ${escape(lead.incoming)}${lead.expectedIncomingKg != null ? ` · ${lead.expectedIncomingKg} kg` : ""}${lead.expectedIncomingAt ? ` · ETA ${escape(lead.expectedIncomingAt)}` : ""}`, `• Bất định: ${escape(context.uncertainties.join(", ") || decision.uncertainties.join(", ") || "Không có")}`, "",
    "🤖 AI đề xuất", escape(decision.recommended_action), "",
    "📌 LÝ DO", escape(decision.reason_summary), "", "Nếu không làm:", escape(decision.expected_state_if_no_action), "",
    "Nếu thực hiện:", escape(decision.expected_state_if_action), "", `⏰ Cần quyết định trước: ${escape(decision.required_by)}`,
    `💰 Trade-off: ${money}`, `🧾 Evidence: ${escape(facts.capturedAt)}`, `🎯 Confidence: ${Math.round(decision.confidence * 100)}%`,
  ].join("\n");
}
