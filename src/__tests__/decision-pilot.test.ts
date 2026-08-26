import { describe, expect, it } from "vitest";
import { DecisionPilotService } from "@/services/impl/DecisionPilotService";
import { MockDecisionRepository } from "@/repositories/mock/MockDecisionRepository";
import { DecisionService } from "@/services/impl/DecisionService";

const incident = { id: "incident-1", incident_key: "WH-01:KHO_TON", warehouse_id: "WH-01", warehouse_name: "Kho HN-01", reason_code: "KHO_TON", reason_name: "Kho tồn", status: "open", priority_score: 72, first_detected_at: "2026-08-22T08:00:00.000Z", last_detected_at: "2026-08-22T09:00:00.000Z" } as any;
const history = [{ incident_id: "incident-1", sync_run_id: "sync-1", recorded_at: "2026-08-22T09:00:00.000Z", affected_order_count: 42, average_age_hours: 12, maximum_age_hours: 31, oldest_order_code: "ORD-1", priority_score: 72, sample_order_codes: ["ORD-1"] }] as any;

function repos() {
  const incidentRepo = { getIncidentById: async () => incident } as any;
  const historyRepo = { getIncidentHistory: async () => history } as any;
  const followupRepo = { getCaseById: async () => ({ id: "followup-1", incident_id: "incident-1", current_state: "FOLLOWING_UP" }) } as any;
  const plannerRepo = { getLatestPlannerRunByIncidentId: async () => ({ id: "planner-1", result: { confidence: { score: 88 }, recommendations: [
    { id: "review-staffing", type: "REVIEW_ASSIGNMENT", title: "Review staffing", description: "Review staffing", priority: "high", targetRole: "WAREHOUSE_MANAGER", rationale: "Backlog is high", evidenceCodes: ["ORD-1"], riskImpact: { severity: "high", potentialConsequence: "SLA breach" }, prerequisiteData: [], manualApprovalRequired: true },
    { id: "monitor", type: "CONTINUE_MONITORING", title: "Continue monitoring", description: "Continue monitoring", priority: "low", targetRole: "OPERATIONS_LEAD", rationale: "Keep observing", evidenceCodes: [], riskImpact: { severity: "low", potentialConsequence: "Delayed response" }, prerequisiteData: [], manualApprovalRequired: true },
  ], investigations: [], limitations: [] } }) } as any;
  return { incidentRepo, historyRepo, followupRepo, plannerRepo };
}

describe("Decision pilot adapter", () => {
  it("reuses incident, root-cause context, follow-up and planner references to create SHADOW", async () => {
    const repository = new MockDecisionRepository();
    const { incidentRepo, historyRepo, followupRepo, plannerRepo } = repos();
    const service = new DecisionPilotService(incidentRepo, historyRepo, followupRepo, plannerRepo, new DecisionService(repository));
    const result = await service.createShadowFromIncident({ incidentId: "incident-1", actor: "pilot" });
    expect(result.ok).toBe(true);
    expect((result.data as any).mode).toBe("SHADOW");
    expect((result.data as any).sourceLinks.followupCaseId).toBe("followup-1");
    expect((result.data as any).sourceLinks.plannerRunId).toBe("planner-1");
    expect((result.data as any).evidence.operationalFacts.affectedOrderCount).toBe(42);
    expect((result.data as any).evidence.actionContext.disposition).toBe("DECIDE");
    expect((result.data as any).evidence.actionContext.selectedOptionId).toBe("review-staffing");
    expect((result.data as any).evidence.actionContext.finalDecisionProvenance.version).toBe("lc01-v1");
    expect((result.data as any).evidence.actionContext.decisionCritic.verdict).toBe("PASS");
    expect((result.data as any).evidence.actionContext.decisionCritic.provenance.version).toBe("lc02-v1");
    expect((result.data as any).financialImpact).toEqual({ status: "NOT_EVALUATED" });
  });

  it("deduplicates repeated pilot creation from the same source fingerprint", async () => {
    const repository = new MockDecisionRepository();
    const { incidentRepo, historyRepo, followupRepo, plannerRepo } = repos();
    const service = new DecisionPilotService(incidentRepo, historyRepo, followupRepo, plannerRepo, new DecisionService(repository));
    const input = { incidentId: "incident-1", actor: "pilot" };
    const first = await service.createShadowFromIncident(input);
    const second = await service.createShadowFromIncident(input);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true); expect(second.idempotent).toBe(true);
    expect(await repository.list()).toHaveLength(1);
  });

  it("resolves follow-up context by incident key and snapshots the newest history row", async () => {
    const repository = new MockDecisionRepository();
    const { incidentRepo, plannerRepo } = repos();
    const historyRepo = {
      getIncidentHistory: async () => [
        { ...history[0], recorded_at: "2026-08-22T08:00:00.000Z", affected_order_count: 7 },
        { ...history[0], recorded_at: "2026-08-22T10:00:00.000Z", affected_order_count: 99 },
      ],
    } as any;
    const followupRepo = {
      getCaseById: async () => null,
      getCasesByIncidentKeys: async () => [{ id: "followup-by-key", incident_id: "incident-1", current_state: "FOLLOWING_UP" }],
    } as any;
    const service = new DecisionPilotService(incidentRepo, historyRepo, followupRepo, plannerRepo, new DecisionService(repository));
    const result = await service.createShadowFromIncident({ incidentId: "incident-1", actor: "pilot" });
    expect(result.ok).toBe(true);
    expect((result.data as any).sourceLinks.followupCaseId).toBe("followup-by-key");
    expect((result.data as any).evidence.operationalFacts.affectedOrderCount).toBe(99);
    expect((result.data as any).evidence.operationalFacts.capturedAt).toEqual(expect.any(String));
  });

  it("fails safe to human investigation when the critic rejects a selected option", async () => {
    const repository = new MockDecisionRepository();
    const { incidentRepo, historyRepo, followupRepo } = repos();
    const plannerRepo = { getLatestPlannerRunByIncidentId: async () => ({ id: "planner-unsafe", result: { confidence: { score: 30 }, recommendations: [
      { id: "unsafe", type: "PREPARE_ESCALATION", title: "Escalate", description: "Escalate now", priority: "high", targetRole: "WAREHOUSE_MANAGER", rationale: "Potential delay", evidenceCodes: [], riskImpact: { severity: "critical", potentialConsequence: "SLA breach" }, prerequisiteData: ["Confirm staffing"], manualApprovalRequired: true },
    ], investigations: [], limitations: ["Evidence unavailable"] } }) } as any;
    const service = new DecisionPilotService(incidentRepo, historyRepo, followupRepo, plannerRepo, new DecisionService(repository));
    const result = await service.createShadowFromIncident({ incidentId: "incident-1", actor: "pilot" });
    expect(result.ok).toBe(true);
    expect((result.data as any).recommendedAction).toMatch(/Verify the missing evidence/i);
    expect((result.data as any).alternatives).toEqual([]);
    expect((result.data as any).evidence.actionContext.disposition).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect((result.data as any).evidence.actionContext.selectedOptionId).toBeNull();
    expect((result.data as any).evidence.actionContext.decisionCritic.reasonCodes).toEqual([
      "EVIDENCE_MISSING", "CONFIDENCE_BELOW_THRESHOLD", "HIGH_RISK_PREREQUISITE_UNRESOLVED",
    ]);
  });
});
