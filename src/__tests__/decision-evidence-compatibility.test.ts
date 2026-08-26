import { describe, expect, it } from "vitest";
import { normalizeDecisionEvidence } from "@/repositories/supabase/SupabaseDecisionRepository";

describe("legacy decision evidence compatibility", () => {
  it("supplies safe empty collections when legacy evidence is missing", () => {
    const evidence = normalizeDecisionEvidence(null, "2026-08-26T00:00:00.000Z");

    expect(evidence.sourceIdentifiers).toEqual({});
    expect(evidence.operationalFacts).toEqual({});
    expect(evidence.capturedAt).toBe("2026-08-26T00:00:00.000Z");
    expect(() => Object.entries(evidence.operationalFacts)).not.toThrow();
  });

  it("preserves valid evidence fields", () => {
    const evidence = normalizeDecisionEvidence({
      sourceIdentifiers: { incidentId: "incident-1" },
      operationalFacts: { affectedOrders: 42 },
      capturedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(evidence.sourceIdentifiers.incidentId).toBe("incident-1");
    expect(evidence.operationalFacts.affectedOrders).toBe(42);
    expect(evidence.capturedAt).toBe("2026-08-25T00:00:00.000Z");
  });
});
