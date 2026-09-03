export type DecisionAction = "APPROVE" | "REJECT" | "EVIDENCE" | "CONFIRM_SEND";
export type DecisionCallback = { requestId: string; action: DecisionAction };
export type DecisionResponseEventAction = "APPROVE" | "REJECT" | "VIEW_EVIDENCE";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const pattern = new RegExp(`^opspdc:(${UUID}):(APPROVE|REJECT|EVIDENCE|CONFIRM_SEND)$`, "i");

export function buildDecisionCallbackData(requestId: string, action: DecisionAction): string {
  const data = `opspdc:${requestId}:${action}`;
  if (!pattern.test(data) || Buffer.byteLength(data, "utf8") > 64) throw new Error("Invalid Telegram decision callback data.");
  return data;
}

export function parseDecisionCallbackData(value: unknown): DecisionCallback | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64) return null;
  const match = pattern.exec(value);
  return match ? { requestId: match[1].toLowerCase(), action: match[2].toUpperCase() as DecisionAction } : null;
}

/** Callback labels stay compact for Telegram; audit values are explicit. */
export function toDecisionResponseEventAction(action: DecisionAction): DecisionResponseEventAction {
  if (action === "CONFIRM_SEND") throw new Error("CONFIRM_SEND is a Level C execution confirmation, not a shadow response.");
  return action === "EVIDENCE" ? "VIEW_EVIDENCE" : action;
}
