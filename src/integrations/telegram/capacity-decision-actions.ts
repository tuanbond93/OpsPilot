export type CapacityDecisionAction = "APPROVE" | "REJECT";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const pattern = new RegExp(`^opspcapdc:(${UUID}):(APPROVE|REJECT)$`, "i");

export function buildCapacityDecisionCallbackData(requestId: string, action: CapacityDecisionAction) {
  const value = `opspcapdc:${requestId}:${action}`;
  if (!pattern.test(value) || Buffer.byteLength(value, "utf8") > 64) throw new Error("INVALID_CAPACITY_DECISION_CALLBACK");
  return value;
}

export function parseCapacityDecisionCallbackData(value: unknown): { requestId: string; action: CapacityDecisionAction } | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64) return null;
  const match = pattern.exec(value);
  return match ? { requestId: match[1].toLowerCase(), action: match[2].toUpperCase() as CapacityDecisionAction } : null;
}
