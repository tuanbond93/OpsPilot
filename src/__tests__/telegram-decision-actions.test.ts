import { describe, expect, it } from "vitest";
import { buildDecisionCallbackData, parseDecisionCallbackData, toDecisionResponseEventAction } from "@/integrations/telegram/decision-actions";
import { buildDecisionMessage } from "@/integrations/telegram/decision-message";
import { decisionSourceSnapshot, DecisionTelegramShadowService, isSyntheticTelegramShadowTest, sourceFingerprint } from "@/services/decision-telegram-shadow";
import { buildTelegramDecisionShadowTest } from "@/services/telegram-decision-shadow-test";
import { canManageTelegramDecision } from "@/integrations/telegram/decision-authorization";

const id = "123e4567-e89b-42d3-a456-426614174000";
describe("manager decision Telegram actions", () => {
  it("uses an isolated, parseable callback namespace within Telegram's limit", () => {
    const callback = buildDecisionCallbackData(id, "APPROVE");
    expect(callback).toBe(`opspdc:${id}:APPROVE`);
    expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
    expect(parseDecisionCallbackData(callback)).toEqual({ requestId: id, action: "APPROVE" });
    expect(parseDecisionCallbackData(buildDecisionCallbackData(id, "CONFIRM_SEND"))).toEqual({ requestId: id, action: "CONFIRM_SEND" });
    expect(parseDecisionCallbackData(`opspwo:${id}:ACKNOWLEDGED`)).toBeNull();
    expect(toDecisionResponseEventAction("EVIDENCE")).toBe("VIEW_EVIDENCE");
    expect(toDecisionResponseEventAction("APPROVE")).toBe("APPROVE");
  });
  it("renders preparation, rejection and evidence controls", () => {
    const message = buildDecisionMessage({ requestId: id, incident: "I", finalDecision: "D", why: "W", expectedOutcome: "O", keyEvidence: ["E"], risks: ["R"], confidence: 85 });
    expect(message.text).toContain("DECISION REQUIRED");
    expect(message.inlineKeyboard.flat().map((item) => item.text)).toEqual(["CHUẨN BỊ GIAO VIỆC", "TỪ CHỐI", "XEM BẰNG CHỨNG"]);
  });
  it("uses a stable fingerprint and the dedicated Telegram adapter", async () => {
    expect(sourceFingerprint({ b: 2, a: [1] })).toBe(sourceFingerprint({ a: [1], b: 2 }));
    const sent: any[] = [];
    const service = new DecisionTelegramShadowService({ sendToChat: async (...args: any[]) => { sent.push(args); return { messageId: "17", response: {} }; } } as any);
    await service.dispatch({ requestId: id, chatId: "-1001", messageThreadId: 55, incident: "I", finalDecision: "D", why: "W", expectedOutcome: "O", keyEvidence: [], risks: [], confidence: 70 });
    expect(sent[0][0]).toBe("-1001");
    expect(sent[0][2].messageThreadId).toBe(55);
  });
  it("fingerprints current source facts rather than the decision record itself", () => {
    const base = decisionSourceSnapshot({
      incident: { id: "i-1", incident_key: "WH:KHO_TON", updated_at: "2026-08-29T00:00:00Z", status: "open" },
      triage: { route: "AI_DECISION_REQUIRED", created_at: "2026-08-29T00:00:00Z", evidence: { directives: ["d1"] } },
      planner: { id: "p-1", result: { recommendations: ["hold"] } },
      history: { recorded_at: "2026-08-29T00:00:00Z", affected_order_count: 2 },
    });
    const changedHistory = { ...base, history: { ...base.history, affected_order_count: 3 } };
    expect(sourceFingerprint(base)).not.toBe(sourceFingerprint(changedHistory));
  });
  it("marks the manager callback fixture as synthetic shadow-only data", () => {
    const testDecision = buildTelegramDecisionShadowTest("admin@example.test", new Date("2026-08-29T00:00:00.000Z"), "11111111-1111-4111-8111-111111111111");
    expect(testDecision.mode).toBe("SHADOW");
    expect(testDecision.sourceLinks).toMatchObject({ sourceType: "TELEGRAM_SHADOW_TEST", sourceId: "11111111-1111-4111-8111-111111111111", triageRoute: "AI_DECISION_REQUIRED", criticVerdict: "PASS" });
    expect(testDecision.evidence.actionContext).toMatchObject({ isTest: true, manualApprovalRequired: true });
    expect(testDecision.evidence.operationalFacts).toMatchObject({ isTest: true, affectedOrderCount: 0 });
    expect(isSyntheticTelegramShadowTest(testDecision.sourceLinks)).toBe(true);
    expect(isSyntheticTelegramShadowTest({ sourceType: "INCIDENT" } as any)).toBe(false);
  });
  it("accepts a pilot manager even when the organization role is employee", () => {
    expect(canManageTelegramDecision({ role: "EMPLOYEE", pilotRole: "MANAGER" })).toBe(true);
    expect(canManageTelegramDecision({ role: "MANAGER", pilotRole: "OPERATOR" })).toBe(true);
    expect(canManageTelegramDecision({ role: "EMPLOYEE", pilotRole: "OPERATOR" })).toBe(false);
  });
});
