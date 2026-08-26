import { describe, it, expect } from "vitest";
import { loadRootCauseDatasets } from "../evaluation/dataset";
import { evaluateRootCauseItem, evaluateRootCauseSuite } from "../evaluation/evaluator";

describe("Sprint 11.5 — Root Cause AI Evaluation Tests", () => {
  it("1. Loads all 5 Root Cause Golden Dataset items", () => {
    const items = loadRootCauseDatasets();
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.id)).toEqual([
      "incident_1_backlog",
      "incident_2_warehouse_delay",
      "incident_3_sync_issue",
      "incident_4_delivery_exception",
      "incident_5_mixed_severity",
    ]);
  });

  it("2. Evaluates individual Root Cause item cleanly", async () => {
    const items = loadRootCauseDatasets();
    const result = await evaluateRootCauseItem(items[0]);
    expect(result.id).toBe("incident_1_backlog");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.passed).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  it("3. Executes full Root Cause evaluation suite", async () => {
    const suite = await evaluateRootCauseSuite();
    expect(suite.totalCount).toBe(5);
    expect(suite.passCount).toBe(5);
    expect(suite.passed).toBe(true);
    expect(suite.averageScore).toBeGreaterThanOrEqual(80);
  });
});
