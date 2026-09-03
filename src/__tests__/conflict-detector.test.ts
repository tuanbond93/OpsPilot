import { describe, expect, it } from "vitest";
import { hasConflictingActions, selectApplicablePlaybookDirectives } from "@/engine/rules/conflict-detector";
describe("deterministic conflict detector", () => {
  it("only flags a direct DO/DONT conflict for the same normalized action", () => {
    expect(hasConflictingActions([{ action: "hold dispatch", polarity: "DO" }, { action: "HOLD DISPATCH", polarity: "DONT" }])).toBe(true);
    expect(hasConflictingActions([{ action: "hold dispatch", polarity: "DO" }, { action: "notify", polarity: "DONT" }])).toBe(false);
  });
  it("fails safe for missing and ambiguous inputs", () => {
    expect(hasConflictingActions(undefined)).toBe(false);
    expect(hasConflictingActions([{ action: "hold", polarity: "MAYBE" }, { action: "hold", polarity: "DO" }])).toBe(false);
  });
  it("does not derive directives from raw source data", () => {
    expect(hasConflictingActions([{ warehouseLog: [{ action: "hold dispatch", polarity: "DO" }] }])).toBe(false);
  });
  it("selects only active registry directives matching the deterministic scope", () => {
    const selected = selectApplicablePlaybookDirectives([
      { id: "global", policyVersion: "v1", reasonCode: "KHO_TON", followupState: null, warehouseId: null, zoneName: null, actionCode: "HOLD", polarity: "DO", priority: 100 },
      { id: "yba", policyVersion: "v2", reasonCode: "KHO_TON", followupState: "PENDING", warehouseId: null, zoneName: "Miền Bắc 3", actionCode: "HOLD", polarity: "DONT", priority: 200 },
      { id: "other", policyVersion: "v1", reasonCode: "KHO_TON", followupState: null, warehouseId: "WH-OTHER", zoneName: null, actionCode: "HOLD", polarity: "DONT", priority: 100 },
    ], { reasonCode: "KHO_TON", followupState: "PENDING", warehouseId: "YBA", zoneName: "Miền Bắc 3" });
    expect(selected.map((directive) => directive.id)).toEqual(["global", "yba"]);
    expect(hasConflictingActions(selected.map((directive) => ({ action: directive.actionCode, polarity: directive.polarity })))).toBe(true);
  });
});
