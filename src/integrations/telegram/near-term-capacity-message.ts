import type { AiRecommendation, CurrentRisk } from "@/domain/near-term-capacity";

function escape(value: string): string { return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!); }
function shown(value: number | null): string { return value == null ? "Chưa có dữ liệu" : String(value); }

/** Fact-only prompt: Lead is never asked to choose an operational action. */
export function formatNearTermFactRequest(facts: CurrentRisk, windowMinutes: number) {
  return [
    "🟠 OPSPILOT — CẦN BỔ SUNG DỮ LIỆU", "", `Kho: ${escape(facts.warehouseName)}`, "",
    "Hiện tại:", `• Hàng cần xử lý: ${shown(facts.currentKg)} kg / ${shown(facts.currentOrders)} đơn`,
    `• B2B: ${shown(facts.b2bOrders)} đơn`, `• COT/SLA risk: ${escape(facts.hardSlaConstraint || facts.riskSignals.join(", "))}`, "",
    `CẦN XÁC NHẬN: Trong ${windowMinutes} phút sắp tới có thêm lượng hàng đáng kể về kho không?`,
  ].join("\n");
}

export const nearTermFactButtons = [
  ["Có — ETA khá chắc chắn", "CONFIRMED_ETA"], ["Có — ETA chưa chắc chắn", "UNCERTAIN_ETA"],
  ["Không có đáng kể", "NO_SIGNIFICANT_INCOMING"], ["Chưa xác định", "UNKNOWN"],
] as const;

export type NearTermFactAnswer = typeof nearTermFactButtons[number][1];
export function buildNearTermFactCallbackData(caseId: string, answer: NearTermFactAnswer) {
  const value = `opspcap:${caseId}:${answer}`;
  if (!/^opspcap:[0-9a-f-]{36}:(CONFIRMED_ETA|UNCERTAIN_ETA|NO_SIGNIFICANT_INCOMING|UNKNOWN)$/i.test(value) || Buffer.byteLength(value) > 64) throw new Error("INVALID_NEAR_TERM_FACT_CALLBACK");
  return value;
}
export function parseNearTermFactCallbackData(value: unknown): { caseId: string; answer: NearTermFactAnswer } | null {
  if (typeof value !== "string") return null;
  const match = /^opspcap:([0-9a-f-]{36}):(CONFIRMED_ETA|UNCERTAIN_ETA|NO_SIGNIFICANT_INCOMING|UNKNOWN)$/i.exec(value);
  return match ? { caseId: match[1].toLowerCase(), answer: match[2].toUpperCase() as NearTermFactAnswer } : null;
}
export function formatNearTermDetailRequest() {
  return "Vui lòng reply đúng 1 dòng: KG=<số>; ETA=<ISO-8601>; TYPE=B2B|ECOM|MIXED. Chỉ cung cấp facts, không chọn phương án xử lý.";
}

/** Manager sees exactly one validated final action; unknown money stays explicit. */
export function formatNearTermManagerCard(warehouseName: string, decision: AiRecommendation) {
  const money = decision.estimated_cost_vnd == null && decision.estimated_saving_vnd == null
    ? "Chưa đủ dữ liệu xác minh chi phí"
    : `Chi phí: ${decision.estimated_cost_vnd ?? "—"}; tiết kiệm: ${decision.estimated_saving_vnd ?? "—"}`;
  return [
    "🔵 OPSPILOT — QUYẾT ĐỊNH CẦN DUYỆT", "", `📍 Kho: ${escape(warehouseName)}`, "",
    "⚠️ RỦI RO", escape(decision.current_risk), "", "🤖 AI ĐỀ XUẤT", escape(decision.recommended_action), "",
    "📌 LÝ DO", escape(decision.reason_summary), "", "Nếu không làm:", escape(decision.expected_state_if_no_action), "",
    "Nếu thực hiện:", escape(decision.expected_state_if_action), "", `⏰ Cần quyết định trước: ${escape(decision.required_by)}`,
    `💰 Chi phí / tiết kiệm: ${money}`, `🎯 Confidence: ${Math.round(decision.confidence * 100)}%`,
  ].join("\n");
}
