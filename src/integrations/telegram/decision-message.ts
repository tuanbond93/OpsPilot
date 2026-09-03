import { buildDecisionCallbackData } from "./decision-actions";

export type DecisionMessageInput = { requestId: string; incident: string; finalDecision: string; why: string; expectedOutcome: string; keyEvidence: string[]; risks: string[]; confidence: number };
export function buildDecisionMessage(input: DecisionMessageInput) {
  const text = ["DECISION REQUIRED", "", `Incident: ${input.incident}`, `Final decision: ${input.finalDecision}`, `Why: ${input.why}`, `Expected outcome: ${input.expectedOutcome}`, `Key evidence: ${input.keyEvidence.join("; ") || "No evidence references"}`, `Risk / limitations: ${input.risks.join("; ") || "None stated"}`, `Confidence: ${Math.round(input.confidence)}%`].join("\n");
  return { text, inlineKeyboard: [[{ text: "CHUẨN BỊ GIAO VIỆC", callbackData: buildDecisionCallbackData(input.requestId, "APPROVE") }, { text: "TỪ CHỐI", callbackData: buildDecisionCallbackData(input.requestId, "REJECT") }], [{ text: "XEM BẰNG CHỨNG", callbackData: buildDecisionCallbackData(input.requestId, "EVIDENCE") }]] };
}
