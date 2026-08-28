import { describe, expect, it } from "vitest";
import { getRoutePromotion, routeIncident, shouldEnqueueAiJob, TRIAGE_ROUTING_VERSION } from "@/engine/rules/triage";

const base = {
  incidentId: "inc-1",
  incidentKey: "WH-01:KHO_TON",
  warehouseId: "WH-01",
  warehouseName: "Kho test",
  reasonCode: "KHO_TON" as const,
  reasonName: "Kho tồn",
  priorityScore: 90,
  affectedOrderCount: 100,
  sampleOrderCodes: ["ORD-1"],
  firstDetectedAt: "2026-08-27T00:00:00.000Z",
  lastDetectedAt: "2026-08-27T01:00:00.000Z",
};

describe("L-10.2B deterministic triage", () => {
  it("routes a known high-severity incident to AUTO_HANDLE without using severity as complexity", () => {
    const result = routeIncident(base);
    expect(result.route).toBe("AUTO_HANDLE");
    expect(result.decisionComplexity).toBe("DETERMINISTIC");
    expect(result.severity).toBe("CRITICAL");
    expect(result.routingVersion).toBe(TRIAGE_ROUTING_VERSION);
  });

  it("routes a low severity known incident to AUTO_HANDLE", () => {
    const result = routeIncident({ ...base, priorityScore: 1, affectedOrderCount: 1 });
    expect(result.route).toBe("AUTO_HANDLE");
    expect(result.severity).toBe("MEDIUM");
  });

  it("routes explicit no-action cases to AUTO_MONITOR", () => {
    expect(routeIncident({ ...base, actionRequired: false }).route).toBe("AUTO_MONITOR");
  });

  it("routes conflicting known actions to AI_DECISION_REQUIRED", () => {
    const result = routeIncident({ ...base, hasConflictingActions: true });
    expect(result.route).toBe("AI_DECISION_REQUIRED");
    expect(result.decisionComplexity).toBe("UNCERTAIN");
  });

  it("never auto-handles an unknown reason", () => {
    const result = routeIncident({ ...base, reasonCode: "UNKNOWN_REASON" as any, reasonName: "Unknown" });
    expect(result.route).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.triageReason).toBe("UNKNOWN_REASON_NO_AUTO_HANDLE");
  });

  it("holds malformed and active-zero inputs before they can create action", () => {
    expect(routeIncident({ ...base, warehouseId: "" }).route).toBe("DATA_QUALITY_HOLD");
    expect(routeIncident({ ...base, affectedOrderCount: 0 }).route).toBe("DATA_QUALITY_HOLD");
  });

  it("routes exhausted deterministic escalation to human investigation", () => {
    const result = routeIncident({ ...base, followupState: "ESCALATED" });
    expect(result.route).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.triageReason).toBe("DETERMINISTIC_ESCALATION_EXHAUSTED");
  });

  it("is idempotent and records pilot-zone evidence without changing its route", () => {
    const input = { ...base, zoneName: "Miền Bắc 3", pilotZoneNames: ["Miền Bắc 3"] };
    expect(routeIncident(input)).toEqual(routeIncident(input));
    expect(routeIncident(input).evidence.pilotScope).toBe(true);
  });

  it("only lets pilot triage suppress the legacy AI queue", () => {
    const outsidePilot = routeIncident(base);
    const pilotRoutine = routeIncident({ ...base, zoneName: "Miền Bắc 3", pilotZoneNames: ["Miền Bắc 3"] });
    const pilotConflict = routeIncident({ ...base, zoneName: "Miền Bắc 3", pilotZoneNames: ["Miền Bắc 3"], hasConflictingActions: true });

    expect(shouldEnqueueAiJob(outsidePilot)).toBe(true);
    expect(shouldEnqueueAiJob(pilotRoutine)).toBe(false);
    expect(shouldEnqueueAiJob(pilotConflict)).toBe(true);
  });

  it("promotes an exhausted auto-handle case to human investigation with an auditable reason", () => {
    const escalated = routeIncident({ ...base, followupState: "ESCALATED" });
    expect(getRoutePromotion("AUTO_HANDLE", escalated)).toEqual({
      from: "AUTO_HANDLE",
      to: "HUMAN_INVESTIGATION_REQUIRED",
      reason: "FOLLOWUP_ESCALATED_CONTEXT_INSUFFICIENT",
    });
  });

  it("does not promote a routine auto-handle case or invent an action dispatch", () => {
    expect(getRoutePromotion("AUTO_HANDLE", routeIncident(base))).toBeNull();
    expect(getRoutePromotion(null, routeIncident({ ...base, followupState: "ESCALATED" }))).toBeNull();
  });
});
