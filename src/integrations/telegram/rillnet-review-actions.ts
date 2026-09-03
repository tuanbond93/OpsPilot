export type RillnetReviewOutcome = "SUCCESS" | "FAILED" | "CONTINUE";

const outcomes: RillnetReviewOutcome[] = ["SUCCESS", "FAILED", "CONTINUE"];

export function buildRillnetReviewCallbackData(requestId: string, outcome: RillnetReviewOutcome) {
  return `opsrr:${requestId}:${outcome}`;
}

export function parseRillnetReviewCallbackData(value: unknown): { requestId: string; outcome: RillnetReviewOutcome } | null {
  if (typeof value !== "string") return null;
  const match = /^opsrr:([0-9a-f-]{36}):(SUCCESS|FAILED|CONTINUE)$/i.exec(value);
  if (!match || !outcomes.includes(match[2].toUpperCase() as RillnetReviewOutcome)) return null;
  return { requestId: match[1], outcome: match[2].toUpperCase() as RillnetReviewOutcome };
}

export function rillnetReviewKeyboard(requestId: string, orderCodes: string[] = []) {
  const copyRows = [...new Set(orderCodes.map((code) => String(code).trim()).filter(Boolean))]
    .slice(0, 5)
    .map((code) => [{ text: `📋 ${code}`, copyText: code }]);
  return [...copyRows, [
    { text: "✅ Thành công", callbackData: buildRillnetReviewCallbackData(requestId, "SUCCESS") },
    { text: "❌ Thất bại", callbackData: buildRillnetReviewCallbackData(requestId, "FAILED") },
  ], [{ text: "👀 Theo dõi tiếp", callbackData: buildRillnetReviewCallbackData(requestId, "CONTINUE") }]];
}
