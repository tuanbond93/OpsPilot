import { describe, expect, it } from "vitest";
import { assessAdaptiveRisk, decideAdaptiveIntervention, hasMaterialStateChange, managerCategory, notificationFatigue, toEmployeeTask } from "@/domain/adaptive-intervention/engine";
import { evaluateAdaptiveShadow } from "@/domain/adaptive-intervention/shadow-harness";
import type { AdaptiveInterventionState, InterventionHistoryItem } from "@/domain/adaptive-intervention/types";

const now = "2026-09-11T02:00:00.000Z";
const state = (overrides: Partial<AdaptiveInterventionState> = {}): AdaptiveInterventionState => ({ caseId: "case-1", incidentKey: "W1:KHO_TON", observedAt: now, resolved: false, evidenceComplete: true, affectedOrderCount: 10, previousAffectedOrderCount: 10, ...overrides });
const prior = (at = "2026-09-11T00:00:00.000Z", extra: Partial<InterventionHistoryItem> = {}): InterventionHistoryItem => ({ type: "FIRST_INTERVENTION", at, confirmed: true, responseReceived: false, producedProgress: false, ...extra });

describe("Adaptive Intervention Engine V2 shadow policy", () => {
  it("1. closes a resolved case", () => expect(decideAdaptiveIntervention(state({ resolved: true })).decision).toBe("CLOSE"));
  it("2. waits until valid exception expiry", () => {
    const result = decideAdaptiveIntervention(state({ validException: { reasonCode: "CUSTOMER_APPOINTMENT", expiresAt: "2026-09-11T05:00:00.000Z" } }));
    expect(result.decision).toBe("WAIT"); expect(result.nextCheckAt).toBe("2026-09-11T05:00:00.000Z");
  });
  it("3. waits for delivery in progress with a valid ETA", () => {
    const result = decideAdaptiveIntervention(state({ deliveryInProgress: true, deliveryEtaAt: "2026-09-11T04:00:00.000Z" }));
    expect(result.nextCheckAt).toBe("2026-09-11T04:30:00.000Z");
  });
  it("4. re-evaluates an expired ETA rather than waiting blindly", () => expect(decideAdaptiveIntervention(state({ deliveryInProgress: true, deliveryEtaAt: "2026-09-11T01:00:00.000Z" })).reasonCode).not.toBe("DELIVERY_PROGRESSING_WITH_ETA"));
  it("5. waits for a credible unexpired commitment", () => expect(decideAdaptiveIntervention(state({ operatorCommitment: { credible: true, receivedAt: now, promisedAt: "2026-09-11T03:00:00.000Z" } })).reasonCode).toBe("VALID_OPERATOR_COMMITMENT"));
  it("6. re-evaluates an expired commitment", () => expect(decideAdaptiveIntervention(state({ operatorCommitment: { credible: true, receivedAt: now, promisedAt: "2026-09-11T01:00:00.000Z" } })).reasonCode).not.toBe("VALID_OPERATOR_COMMITMENT"));
  it("7. waits when backlog decreases materially and SLA is safe", () => expect(decideAdaptiveIntervention(state({ affectedOrderCount: 6, previousAffectedOrderCount: 10, materialEvents: ["BACKLOG_DECREASED"] })).reasonCode).toBe("BACKLOG_IMPROVING"));
  it("8. raises risk for increasing backlog", () => expect(assessAdaptiveRisk(state({ materialEvents: ["BACKLOG_INCREASED"] })).level).toBe("HIGH"));
  it("9. acts now for high risk without prior push", () => expect(decideAdaptiveIntervention(state({ driverAssigned: false })).decision).toBe("ACT_NOW"));
  it("10. avoids duplicate after a recent intervention without change", () => expect(decideAdaptiveIntervention(state({ interventions: [prior("2026-09-11T01:30:00.000Z")] })).reasonCode).toBe("RECENT_INTERVENTION_NO_CHANGE"));
  it("11. escalates repeated ignored interventions", () => expect(decideAdaptiveIntervention(state({ interventions: [prior(), prior("2026-09-11T00:30:00.000Z")] })).decision).toBe("ESCALATE"));
  it("12. increases fatigue for repeated confirmed unproductive interventions", () => expect(notificationFatigue(state({ interventions: [prior(), prior("2026-09-11T00:30:00.000Z")] }))).toBe("HIGH"));
  it("13. critical risk overrides fatigue and raises authority", () => {
    const result = decideAdaptiveIntervention(state({ slaDeadlineAt: "2026-09-11T02:15:00.000Z", interventions: [prior(), prior("2026-09-11T00:30:00.000Z")] }));
    expect(result.decision).toBe("ESCALATE"); expect(result.target).toBe("MANAGER");
  });
  it("14. missing evidence lowers confidence and requests information", () => {
    const result = decideAdaptiveIntervention(state({ evidenceComplete: false }));
    expect(result.decision).toBe("REQUEST_INFORMATION"); expect(result.confidence).toBe("LOW");
  });
  it("15. no driver with SLA near is high risk", () => expect(assessAdaptiveRisk(state({ driverAssigned: false, slaDeadlineAt: "2026-09-11T03:00:00.000Z" })).level).toBe("HIGH"));
  it("16. an expired exception is not treated as valid suppression", () => expect(decideAdaptiveIntervention(state({ validException: { reasonCode: "DAMAGED", expiresAt: "2026-09-11T01:00:00.000Z" } })).suppressionStatus).toBe("EXPIRED_EXCEPTION"));
  it("17. duplicate/no event is not a material state change", () => {
    expect(hasMaterialStateChange(state({ materialEvents: [] }))).toBe(false);
    expect(hasMaterialStateChange(state({ materialEvents: ["DRIVER_ASSIGNED"] }))).toBe(true);
  });
  it("18. classifies V1 push 2 versus V2 valid-progress wait", () => {
    const report = evaluateAdaptiveShadow([state({ v1Decision: "SECOND_PUSH", deliveryInProgress: true, deliveryEtaAt: "2026-09-11T04:00:00.000Z" })]);
    expect(report.comparisons[0].classification).toBe("V2_AVOIDS_UNNECESSARY_NOTIFICATION");
  });
  it("19. classifies V1 push 2 versus V2 escalation", () => {
    const report = evaluateAdaptiveShadow([state({ v1Decision: "SECOND_PUSH", interventions: [prior(), prior("2026-09-11T00:30:00.000Z")] })]);
    expect(report.comparisons[0].classification).toBe("V2_ESCALATES_INSTEAD_OF_REPEAT");
  });
  it("20. emits nextCheckAt for every WAIT and exposes inbox/manager contracts", () => {
    const wait = decideAdaptiveIntervention(state());
    const action = decideAdaptiveIntervention(state({ driverAssigned: false }));
    expect(wait.decision).toBe("WAIT"); expect(wait.nextCheckAt).not.toBeNull();
    expect(toEmployeeTask(action)?.allowedResponses).toContain("CANNOT_COMPLETE");
    expect(managerCategory(action)).toBe("AT_RISK");
  });
});
