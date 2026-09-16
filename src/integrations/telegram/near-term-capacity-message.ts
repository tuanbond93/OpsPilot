import type { AiRecommendation, CurrentRisk, DecisionContext, LeadFact } from "@/domain/near-term-capacity";

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
    "⚠️ Vấn đề vận hành", escape(decision.current_risk), `• Hiện tại: ${shown(facts.currentKg)} kg / ${shown(facts.currentOrders)} đơn`,
    `• Facts từ Lead: ${escape(lead.incoming)}${lead.expectedIncomingKg != null ? ` · ${lead.expectedIncomingKg} kg` : ""}${lead.expectedIncomingAt ? ` · ETA ${escape(lead.expectedIncomingAt)}` : ""}`, `• Bất định: ${escape(context.uncertainties.join(", ") || decision.uncertainties.join(", ") || "Không có")}`, "",
    "🤖 AI đề xuất", escape(decision.recommended_action), "",
    "📌 LÝ DO", escape(decision.reason_summary), "", "Nếu không làm:", escape(decision.expected_state_if_no_action), "",
    "Nếu thực hiện:", escape(decision.expected_state_if_action), "", `⏰ Cần quyết định trước: ${escape(decision.required_by)}`,
    `💰 Trade-off: ${money}`, `🧾 Evidence: ${escape(facts.capturedAt)}`, `🎯 Confidence: ${Math.round(decision.confidence * 100)}%`,
  ].join("\n");
}
