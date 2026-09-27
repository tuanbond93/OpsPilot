import { describe, expect, it } from "vitest";
import {
  SCENARIO_FIXTURES_CREATED,
  createFourScenarioParityFixtures,
  executeIsolatedV1Reference,
} from "@/engine/checkpoint-v2/four-scenario-parity-harness";

describe("Checkpoint V2 four-scenario parity harness", () => {
  it("creates exactly the four canonical fixtures", () => {
    const fixtures = createFourScenarioParityFixtures();
    expect(SCENARIO_FIXTURES_CREATED).toBe(4);
    expect(fixtures).toHaveLength(4);
    expect(fixtures.map(fixture => fixture.scenario)).toEqual([
      "NEW_FIRST_PUSH", "UNCHANGED_WAITING", "BACKLOG_CHANGED", "RESOLVED_COMPLETED",
    ]);
    expect(new Set(fixtures.map(fixture => fixture.checkpointAt)).size).toBe(1);
    expect(new Set(fixtures.map(fixture => fixture.syncRunId)).size).toBe(4);
    expect(new Set(fixtures.map(fixture => fixture.caseId)).size).toBe(4);
  });

  it("executes every canonical fixture through isolated governed V1 Phase 6", async () => {
    const results = await Promise.all(createFourScenarioParityFixtures().map(executeIsolatedV1Reference));
    expect(results).toHaveLength(SCENARIO_FIXTURES_CREATED);
    for (const result of results) {
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].incidentKey).toBe(result.fixture.comparison.case.incidentKey);
      expect(result.decisions[0].oldState).toBe(result.fixture.comparison.decision.oldState);
      expect(result.decisions[0].newState).toBe(result.fixture.comparison.decision.expectedNewState);
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0].incident_key).toBe(result.fixture.comparison.case.incidentKey);
      expect(result.cases[0].current_state).toBe(result.fixture.comparison.decision.expectedNewState);
      expect(result.cases[0].member_generation_id).toBe(result.fixture.comparison.generation.id);
    }
  });
});
