import { describe, expect, it } from "vitest";
import { makeFinalDecision } from "@/domain/final-decision";
import type { FinalDecisionInput } from "@/domain/final-decision";

function input(overrides: Partial<FinalDecisionInput> = {}): FinalDecisionInput {
  return {
    incidentId: "incident-1",
    plannerRunId: "planner-1",
    plannerConfidence: 83.6,
    recommendations: [
      {
        id: "monitor",
        type: "CONTINUE_MONITORING",
        title: "Monitor",
        description: "Continue monitoring the incident",
        priority: "low",
        targetRole: "OPERATIONS_LEAD",
        rationale: "Trend is stable",
        evidenceCodes: ["snapshot:1"],
        riskImpact: { severity: "low", potentialConsequence: "Delayed response" },
        prerequisiteData: [],
        manualApprovalRequired: true,
      },
      {
        id: "escalate",
        type: "PREPARE_ESCALATION",
        title: "Prepare escalation",
        description: "Prepare an escalation for the warehouse lead",
        priority: "high",
        targetRole: "WAREHOUSE_MANAGER",
        rationale: "Backlog and age are both high",
        evidenceCodes: ["order:2", "order:1", "order:1"],
        riskImpact: { severity: "critical", potentialConsequence: "SLA breach" },
        prerequisiteData: ["Confirm current staffing"],
        manualApprovalRequired: true,
      },
    ],
    investigations: [],
    limitations: ["No live staffing feed"],
    generatedAt: "2026-08-26T01:00:00.000Z",
    ...overrides,
  };
}

describe("LC-01 deterministic final decision engine", () => {
  it("selects one option by stable evidence-aware ranking", () => {
    const result = makeFinalDecision(input());
    expect(result.disposition).toBe("DECIDE");
    expect(result.selectedOption?.optionId).toBe("escalate");
    expect(result.alternatives.map((item) => item.optionId)).toEqual(["monitor"]);
    expect(result.evidenceRefs).toEqual(["order:1", "order:2"]);
    expect(result.confidence).toBe(84);
    expect(result.provenance).toEqual({
      engine: "DETERMINISTIC_FINAL_DECISION",
      version: "lc01-v1",
      incidentId: "incident-1",
      plannerRunId: "planner-1",
      generatedAt: "2026-08-26T01:00:00.000Z",
    });
  });

  it("uses option id as a deterministic tie breaker", () => {
    const base = input().recommendations[0];
    const result = makeFinalDecision(input({ recommendations: [{ ...base, id: "z-option" }, { ...base, id: "a-option" }] }));
    expect(result.selectedOption?.optionId).toBe("a-option");
  });

  it("requires human investigation when no governed candidate exists", () => {
    const result = makeFinalDecision(input({
      recommendations: [],
      investigations: [{ id: "investigate-1", priority: "high", action: "Verify scan events", rationale: "Scan history is incomplete", targetDepartment: "WAREHOUSE_OPS", requiredData: ["scan-log"], safetyCheck: "Read-only review" }],
    }));
    expect(result.disposition).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.selectedOption).toBeNull();
    expect(result.humanInvestigation).toMatchObject({ action: "Verify scan events", requiredData: ["scan-log"] });
  });

  it("contains no financial fields or money semantics", () => {
    expect(JSON.stringify(makeFinalDecision(input()))).not.toMatch(/saving|cost|financial|money/i);
  });
});
