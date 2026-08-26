import { describe, it, expect } from "vitest";
import { loadPlannerDatasets } from "../evaluation/dataset";
import { evaluatePlannerItem, evaluatePlannerSuite } from "../evaluation/evaluator";

describe("Sprint 11.5 — Action Planner AI Evaluation Tests", () => {
  it("1. Loads all 5 Action Planner Golden Dataset items", () => {
    const items = loadPlannerDatasets();
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.id)).toEqual([
      "planner_1_backlog",
      "planner_2_warehouse_delay",
      "planner_3_sync_issue",
      "planner_4_delivery_exception",
      "planner_5_mixed_severity",
    ]);
  });

  it("2. Evaluates individual Action Planner item cleanly", async () => {
    const items = loadPlannerDatasets();
    const result = await evaluatePlannerItem(items[0]);
    expect(result.id).toBe("planner_1_backlog");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.passed).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  it("3. Executes full Action Planner evaluation suite", async () => {
    const suite = await evaluatePlannerSuite();
    expect(suite.totalCount).toBe(5);
    expect(suite.passCount).toBe(5);
    expect(suite.passed).toBe(true);
    expect(suite.averageScore).toBeGreaterThanOrEqual(80);
  });
});
