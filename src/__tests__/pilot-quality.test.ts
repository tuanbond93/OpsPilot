import { describe, expect, it } from "vitest";
import { buildPilotQualitySnapshot } from "../services/pilot-quality";

describe("pilot quality snapshot", () => {
  it("aggregates only observed production evidence", () => {
    const result = buildPilotQualitySnapshot({
      generatedAt: "2026-08-23T00:00:00.000Z",
      verifications: [
        { incidentId: "i1", actualCause: "STAFFING", verifiedAt: "2026-08-22", warehouseName: "Kho A", incidentType: "Kho tồn" },
        { incidentId: "i1", actualCause: "PROCESS", verifiedAt: "2026-08-23", warehouseName: "Kho A", incidentType: "Kho tồn" },
        { incidentId: "i2", actualCause: "STAFFING", verifiedAt: "2026-08-23", warehouseName: "Kho B", incidentType: "Thiếu shipper" },
      ],
      feedback: [
        { id: "f1", category: "DATA", reportedAt: "2026-08-23", currentStatus: "RESOLVED" },
        { id: "f2", category: "AI", reportedAt: "2026-08-23", currentStatus: "OPEN" },
      ],
      reviews: [
        { status: "APPROVED", rating: 5, reviewedAt: "2026-08-22" },
        { status: "EDITED", rating: 3, reviewedAt: "2026-08-23" },
        { status: "PENDING", rating: null, reviewedAt: "2026-08-23" },
      ],
      decisions: [
        { id: "d1", mode: "SHADOW", status: "DRAFT" },
        { id: "d2", mode: "HUMAN_APPROVAL", status: "READY_FOR_REVIEW" },
      ],
      outcomes: [{ decisionId: "d1", status: "SUCCESS", measuredAt: "2026-08-23" }],
      authEnforced: true,
    });

    expect(result.sample.verifiedIncidents).toBe(2);
    expect(result.sample.reviewedCopilotResults).toBe(2);
    expect(result.review.averageRating).toBe(4);
    expect(result.feedback.resolutionRate).toBe(0.5);
    expect(result.decision.outcomeCoverage).toBe(0.5);
    expect(result.verificationCauses[0]).toEqual({ label: "STAFFING", count: 2 });
    expect(result.sample.verifiedWarehouses).toBe(2);
    expect(result.verificationCoverage.byWarehouse).toEqual([
      { label: "Kho A", count: 2 },
      { label: "Kho B", count: 1 },
    ]);
    expect(result.activityTrend).toHaveLength(2);
    expect(result.readiness.find((item) => item.key === "identity_rbac")?.state).toBe("HAS_EVIDENCE");
  });

  it("reports missing samples as null instead of a fabricated perfect score", () => {
    const result = buildPilotQualitySnapshot({ verifications: [], feedback: [], reviews: [], decisions: [], outcomes: [] });
    expect(result.review.averageRating).toBeNull();
    expect(result.feedback.resolutionRate).toBeNull();
    expect(result.decision.outcomeCoverage).toBeNull();
  });
});
