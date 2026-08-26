import { describe, expect, it } from "vitest";
import { validateCreateDecision, validateOutcomeInput, validateTransitionInput } from "@/domain/decision";

describe("Decision API input contract", () => {
  it("rejects malformed create payload fields", () => {
    expect(() => validateCreateDecision({ mode: "HUMAN_APPROVAL", actor: "", confidence: 101 } as any)).toThrow(/actor|source|riskLevel/i);
    expect(() => validateCreateDecision({ mode: "AUTONOMOUS", actor: "operator" } as any)).toThrow(/AUTONOMOUS/i);
    expect(() => validateCreateDecision({ ...({} as any), mode: "UNSAFE", actor: "operator", riskLevel: "HIGH", sourceLinks: { sourceType: "x", sourceId: "y" }, sourceFingerprint: "f", idempotencyKey: "i", problem: "p", rootCause: "r", recommendedAction: "a", confidence: 50, evidence: { operationalFacts: {} } })).toThrow(/mode/i);
    expect(() => validateCreateDecision({ ...({} as any), mode: "SHADOW", actor: "operator", riskLevel: "UNSAFE", sourceLinks: { sourceType: "x", sourceId: "y" }, sourceFingerprint: "f", idempotencyKey: "i", problem: "p", rootCause: "r", recommendedAction: "a", confidence: 50, evidence: { operationalFacts: {} } })).toThrow(/riskLevel/i);
  });

  it("requires API idempotency keys and reject reasons", () => {
    expect(() => validateTransitionInput({ decisionId: "d", targetStatus: "APPROVED", actor: "operator", idempotencyKey: "" })).toThrow(/idempotencyKey/);
    expect(() => validateTransitionInput({ decisionId: "d", targetStatus: "REJECTED", actor: "operator", idempotencyKey: "r" })).toThrow(/rejectReason/);
    expect(() => validateTransitionInput({ decisionId: "d", targetStatus: "SIDEWAYS", actor: "operator", idempotencyKey: "r" } as any)).toThrow(/targetStatus/);
  });

  it("validates outcome timestamps and inconclusive reasons", () => {
    expect(() => validateOutcomeInput({ decisionId: "d", status: "SUCCESS", observedOutcome: "ok", measuredAt: "not-a-date", actor: "observer", idempotencyKey: "o" })).toThrow(/measuredAt/);
    expect(() => validateOutcomeInput({ decisionId: "d", status: "INCONCLUSIVE", observedOutcome: "unknown", measuredAt: new Date().toISOString(), actor: "observer", idempotencyKey: "o" })).toThrow(/inconclusiveReason/);
    expect(() => validateOutcomeInput({ decisionId: "d", status: "UNKNOWN", observedOutcome: "unknown", measuredAt: new Date().toISOString(), actor: "observer", idempotencyKey: "o" } as any)).toThrow(/status/);
  });
});
