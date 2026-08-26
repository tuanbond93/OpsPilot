import { describe, expect, it } from "vitest";
import { critiqueFinalDecision } from "@/domain/decision-critic";
import type { FinalDecisionResult } from "@/domain/final-decision";

function decision(overrides: Partial<FinalDecisionResult> = {}): FinalDecisionResult {
  return {
    disposition: "DECIDE",
    selectedOption: { optionId: "option-1", action: "Escalate backlog review", rationale: "Backlog is aging", priority: "high", riskSeverity: "high", evidenceRefs: ["snapshot:1"], prerequisiteData: [], targetRole: "OPERATIONS_LEAD", score: 60 },
    alternatives: [],
    selectionRationale: "Highest governed rank",
    expectedOperationalOutcome: "Reassess backlog after the approved action",
    risksAndLimitations: [],
    confidence: 80,
    evidenceRefs: ["snapshot:1"],
    humanInvestigation: null,
    provenance: { engine: "DETERMINISTIC_FINAL_DECISION", version: "lc01-v1", incidentId: "incident-1", plannerRunId: "planner-1", generatedAt: "2026-08-26T01:00:00.000Z" },
    ...overrides,
  };
}

describe("LC-02 deterministic decision critic", () => {
  it("passes an evidence-backed decision above the risk threshold", () => {
    const result = critiqueFinalDecision({ finalDecision: decision(), reviewedAt: "2026-08-26T02:00:00.000Z" });
    expect(result.verdict).toBe("PASS");
    expect(result.reasonCodes).toEqual([]);
    expect(result.checks.confidenceThreshold).toBe(65);
    expect(result.provenance).toEqual({ critic: "DETERMINISTIC_DECISION_CRITIC", version: "lc02-v1", reviewedDecisionVersion: "lc01-v1", reviewedAt: "2026-08-26T02:00:00.000Z" });
  });

  it("abstains when evidence is missing or confidence is below the risk threshold", () => {
    const result = critiqueFinalDecision({ finalDecision: decision({ confidence: 40, evidenceRefs: [] }) });
    expect(result.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.reasonCodes).toEqual(["EVIDENCE_MISSING", "CONFIDENCE_BELOW_THRESHOLD"]);
  });

  it("abstains on unresolved prerequisites for high-risk options", () => {
    const base = decision();
    const result = critiqueFinalDecision({ finalDecision: decision({ selectedOption: { ...base.selectedOption!, prerequisiteData: ["Confirm staffing"] } }) });
    expect(result.reasonCodes).toContain("HIGH_RISK_PREREQUISITE_UNRESOLVED");
    expect(result.humanInvestigation?.requiredData).toEqual(["Confirm staffing"]);
  });

  it("preserves upstream human-investigation disposition", () => {
    const result = critiqueFinalDecision({ finalDecision: decision({ disposition: "HUMAN_INVESTIGATION_REQUIRED", selectedOption: null, evidenceRefs: [], humanInvestigation: { action: "Inspect scan logs", rationale: "No candidate", requiredData: ["scan-log"] } }) });
    expect(result.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.reasonCodes).toEqual(["UPSTREAM_ABSTAINED", "SELECTED_OPTION_MISSING"]);
    expect(result.humanInvestigation?.action).toBe("Inspect scan logs");
  });

  it("contains no financial or execution semantics", () => {
    expect(JSON.stringify(critiqueFinalDecision({ finalDecision: decision() }))).not.toMatch(/saving|cost|financial|execute|money/i);
  });
});
