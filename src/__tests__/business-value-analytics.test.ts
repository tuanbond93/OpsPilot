import { describe, expect, it } from "vitest";
import { buildBusinessValueReport, resolveSuppressionEvidence, type BusinessValueCaseEvidence } from "@/domain/business-value/analytics";

const base = (id: string, state = "FIRST_PUSH_SENT") => ({
  id, incident_id: `incident-${id}`, incident_key: `key-${id}`, current_state: state as any,
  first_detected_at: "2026-09-12T01:00:00.000Z", last_checked_at: "2026-09-12T03:00:00.000Z",
  baseline_affected_order_count: 2, latest_affected_order_count: 1, current_progress_percent: 0, current_assessment: "no_progress" as const,
});
const action = (id: string, type: "FIRST_PUSH" | "SECOND_PUSH" | "ESCALATION", processedAt: string, outcome: "DELIVERED" | "FAILED" = "DELIVERED") => ({
  id, action_type: type, provider: "telegram", target_type: "WAREHOUSE" as const, payload: { incidentId: `incident-${id[0]}` }, status: "SENT" as const,
  priority: "high" as const, retry_count: 0, max_retry: 1, scheduled_at: processedAt, processed_at: processedAt, outcome, provider_message_id: "123",
});

describe("business value analytics read model", () => {
  it("attributes a resolution after a confirmed first push only", () => {
    const report = buildBusinessValueReport([{ followupCase: { ...base("a", "RESOLVED"), resolved_at: "2026-09-12T04:00:00.000Z" }, suppressionEvidenceComplete: true, actions: [action("a1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z")] }]);
    expect(report.cases[0].outcome).toBe("RESOLVED_AFTER_FIRST_PUSH");
    expect(report.metrics.firstPushResolutionRate).toBe(1);
    expect(report.metrics.medianTimeAfterFirstPushHours).toBe(2);
  });

  it("keeps an unresolved first-push case out of resolution outcomes", () => {
    const report = buildBusinessValueReport([{ followupCase: base("b"), suppressionEvidenceComplete: true, actions: [action("b1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z")] }]);
    expect(report.cases[0].outcome).toBe("STILL_UNRESOLVED");
    expect(report.metrics.stillUnresolved).toBe(1);
  });

  it("attributes second-push and escalation resolutions as mutually exclusive", () => {
    const report = buildBusinessValueReport([
      { followupCase: { ...base("c", "RESOLVED"), resolved_at: "2026-09-12T05:00:00.000Z" }, suppressionEvidenceComplete: true, actions: [action("c1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z"), action("c2", "SECOND_PUSH", "2026-09-12T03:00:00.000Z")] },
      { followupCase: { ...base("d", "RESOLVED"), resolved_at: "2026-09-12T06:00:00.000Z" }, suppressionEvidenceComplete: true, actions: [action("d1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z"), action("d2", "SECOND_PUSH", "2026-09-12T03:00:00.000Z"), action("d3", "ESCALATION", "2026-09-12T04:00:00.000Z")] },
    ]);
    expect(report.metrics.secondPushResolutionCount).toBe(1);
    expect(report.metrics.escalationResolutionCount).toBe(1);
    expect(report.metrics.firstPushResolutionCount).toBe(0);
  });

  it("excludes suppressed cases and records deduplication events", () => {
    const report = buildBusinessValueReport([{ followupCase: base("e"), suppressionEvidenceComplete: true, suppressionEvidence: [{ source: "EXTERNAL_POLICY", reason: "CUSTOMER_APPOINTMENT", status: "CURRENT" }], actionEvents: [{ id: "ev", action_id: "x", event_type: "ACTION_DEDUPLICATED", attempt_number: 0 }] }]);
    expect(report.metrics.totalActionable).toBe(0);
    expect(report.metrics.suppressedCases).toBe(1);
    expect(report.metrics.duplicateActionsPrevented).toBe(1);
  });

  it("never treats a pending or failed dispatch as confirmed", () => {
    const pending = { ...action("f1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z"), status: "PENDING" as const, outcome: null };
    const report = buildBusinessValueReport([{ followupCase: { ...base("f", "RESOLVED"), resolved_at: "2026-09-12T04:00:00.000Z" }, suppressionEvidenceComplete: true, actions: [pending] }]);
    expect(report.cases[0].outcome).toBe("MISSING_EVIDENCE");
    expect(report.metrics.firstPushConfirmed).toBe(0);
  });

  it("keeps a resolved case with no action evidence in the missing-evidence bucket", () => {
    const report = buildBusinessValueReport([{ followupCase: { ...base("m", "RESOLVED"), resolved_at: "2026-09-12T04:00:00.000Z" }, suppressionEvidenceComplete: true }]);
    expect(report.cases[0].outcome).toBe("MISSING_EVIDENCE");
  });

  it("identifies invalid ordering and preserves missing timestamp measurements as N/A", () => {
    const report = buildBusinessValueReport([{ followupCase: base("g"), suppressionEvidenceComplete: true, actions: [action("g2", "SECOND_PUSH", "2026-09-12T02:00:00.000Z")] }]);
    expect(report.metrics.invalidStageActions).toBe(1);
    expect(report.metrics.medianTimeToFirstPushHours).toBeNull();
  });

  it("accepts caller-provided scope selections without cross-scope aggregation", () => {
    const all: BusinessValueCaseEvidence[] = [{ followupCase: base("mb3"), suppressionEvidenceComplete: true, scope: { warehouseId: "MB3" } }, { followupCase: base("hcm"), suppressionEvidenceComplete: true, scope: { warehouseId: "HCM" } }];
    const mb3 = all.filter(item => item.scope?.warehouseId === "MB3");
    expect(buildBusinessValueReport(mb3).metrics.totalDetected).toBe(1);
  });

  it("distinguishes current, expired, conflicting, and unknown suppression evidence", () => {
    const current = resolveSuppressionEvidence({ followupCase: base("s"), suppressionEvidenceComplete: true, suppressionEvidence: [{ source: "EXTERNAL_POLICY", reason: "DAMAGED", status: "CURRENT" }] });
    const expired = resolveSuppressionEvidence({ followupCase: base("x"), suppressionEvidenceComplete: true, caseOrderCodes: ["O-1"], referenceTime: "2026-09-12T04:00:00.000Z", orderExceptions: [{ id: "x", order_code: "O-1", reason_code: "DAMAGED", reason_name: "Damaged", expires_at: "2026-09-12T03:00:00.000Z" }] });
    const conflicting = resolveSuppressionEvidence({ followupCase: base("y"), suppressionEvidenceComplete: true, suppressionEvidence: [{ source: "EXTERNAL_POLICY", reason: "DAMAGED", status: "CURRENT" }, { source: "EXTERNAL_POLICY", reason: "NO_EXCEPTION", status: "NONE" }] });
    const unknown = resolveSuppressionEvidence({ followupCase: base("z"), suppressionEvidenceComplete: false });
    expect(current.status).toBe("CURRENT");
    expect(expired.status).toBe("HISTORICAL");
    expect(conflicting.status).toBe("AMBIGUOUS");
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("requires a case-linked durable delivery record, not a message-only grouped record", () => {
    const unlinked = { ...action("q1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z"), payload: { incidentId: "another-case" } };
    const report = buildBusinessValueReport([{ followupCase: base("q"), suppressionEvidenceComplete: true, actions: [unlinked] }]);
    expect(report.cases[0].firstPushEvidenceLevel).toBe("LEVEL_C_MESSAGE_ONLY");
    expect(report.metrics.firstPushConfirmed).toBe(0);
  });

  it("assigns every case to exactly one terminal outcome bucket", () => {
    const report = buildBusinessValueReport([
      { followupCase: { ...base("u", "RESOLVED"), resolved_at: "2026-09-12T04:00:00.000Z" }, suppressionEvidenceComplete: true, actions: [action("u1", "FIRST_PUSH", "2026-09-12T02:00:00.000Z")] },
      { followupCase: base("v"), suppressionEvidenceComplete: true },
      { followupCase: base("w"), suppressionEvidenceComplete: true, suppressionEvidence: [{ source: "EXTERNAL_POLICY", reason: "DAMAGED", status: "CURRENT" }] },
    ]);
    expect(new Set(report.cases.map(item => item.caseId)).size).toBe(3);
    expect(report.cases.map(item => item.outcome).sort()).toEqual(["RESOLVED_AFTER_FIRST_PUSH", "STILL_UNRESOLVED", "SUPPRESSED"]);
  });
});
