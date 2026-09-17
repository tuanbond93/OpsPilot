import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { authorize, isCron, generateMock, createAndDispatchMock } = vi.hoisted(() => ({
  authorize: vi.fn(),
  isCron: vi.fn(() => false),
  generateMock: vi.fn(),
  createAndDispatchMock: vi.fn(),
}));

vi.mock("@/security/api-security", () => ({
  authorizeApiRequest: authorize,
  isCronAuthorized: isCron,
}));

vi.mock("@/ai/provider", () => ({
  generate: generateMock,
}));

vi.mock("@/services/near-term-capacity-decision-bridge", () => ({
  NearTermCapacityDecisionBridge: class {
    createAndDispatch = createAndDispatchMock;
  },
}));

import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
import { POST } from "@/app/api/internal/near-term-capacity/resume/route";
import type { CurrentRisk, LeadFact } from "@/domain/near-term-capacity";

const sampleRisk: CurrentRisk = {
  warehouseId: "WH-YBA",
  warehouseName: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
  capturedAt: "2026-09-16T07:00:00.000Z",
  currentOrders: 15,
  currentKg: 450,
  b2bOrders: 2,
  orderCodes: ["ORD-1", "ORD-2"],
  evidenceRefs: ["incident:123"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Persisted warehouse backlog risk",
};

const sampleLeadFact: LeadFact = {
  interactionId: "e2524b83-4462-4238-8914-cd371ab51106",
  suppliedBy: "telegram:user_123",
  capturedAt: "2026-09-16T08:03:23.000Z",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  confidence: "LOW",
};

function createMockDb(initialRow: Record<string, unknown> | null) {
  let currentRow = initialRow ? { ...initialRow } : null;
  const events: Array<Record<string, unknown>> = [];

  const db: any = {
    from: vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col1: string, val1: unknown) => ({
              eq: vi.fn((col2: string, val2: unknown) => ({
                maybeSingle: vi.fn(async () => {
                  if (currentRow && currentRow[col1] === val1 && currentRow[col2] === val2) {
                    return { data: { ...currentRow }, error: null };
                  }
                  return { data: null, error: null };
                }),
              })),
            })),
          })),
          update: vi.fn((updates: Record<string, unknown>) => ({
            eq: vi.fn((col: string, val: unknown) => {
              if (currentRow && currentRow[col] === val) {
                Object.assign(currentRow, updates);
              }
              return Promise.resolve({ error: null });
            }),
          })),
        };
      }
      if (table === "near_term_capacity_events") {
        return {
          insert: vi.fn(async (event: Record<string, unknown>) => {
            events.push(event);
            return { error: null };
          }),
        };
      }
      return {};
    }),
    _getCurrentRow: () => currentRow,
    _getEvents: () => events,
  };

  return db;
}

describe("Near-term capacity governed case resume", () => {
  const caseId = "e2524b83-4462-4238-8914-cd371ab51106";

  beforeEach(() => {
    vi.clearAllMocks();
    isCron.mockReturnValue(false);
    createAndDispatchMock.mockResolvedValue({ status: "DISPATCHED", idempotent: false });
  });

  it("successfully resumes a valid HUMAN_INVESTIGATION_REQUIRED case to DECISION_READY and dispatches manager card", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: sampleLeadFact,
      status: "HUMAN_INVESTIGATION_REQUIRED",
      active: true,
      decision_id: null,
    });

    const aiRecommendationJson = JSON.stringify({
      decision_case_id: caseId,
      recommended_action: "NO_ACTION_MONITOR",
      confidence: 0.85,
      reason_summary: "No significant incoming confirmed by warehouse lead; backlog can be monitored without adding resources.",
      current_risk: "Persisted warehouse backlog risk",
      expected_state_if_no_action: "SLA breach within 4 hours if volume increases",
      expected_state_if_action: "Backlog stabilized without vehicle additions",
      key_evidence: ["incident:123"],
      uncertainties: [],
      execution_instruction: "Monitor warehouse throughput through next checkpoint cycle.",
      required_by: "2026-09-16T12:00:00.000Z",
      required_followup_at: "2026-09-16T14:00:00.000Z",
      estimated_cost_vnd: null,
      estimated_saving_vnd: null,
    });

    generateMock.mockResolvedValue({ text: aiRecommendationJson, model: "gpt-4o" });

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId, "admin_operator");

    expect(result.status).toBe("DECISION_READY");
    expect(result.recommendation).toBe("NO_ACTION_MONITOR");
    expect(result.criticVerdict).toBe("VALID_DECISION");

    const updated = db._getCurrentRow();
    expect(updated.status).toBe("DECISION_READY");
    expect(updated.ai_recommendation).toBeDefined();
    expect(updated.critic_result.verdict).toBe("VALID_DECISION");

    expect(createAndDispatchMock).toHaveBeenCalledTimes(1);

    const eventTypes = db._getEvents().map((e: any) => e.event_type);
    expect(eventTypes).toContain("AI_DECISION_RESUME_STARTED");
    expect(eventTypes).toContain("AI_DECISION_CREATED");
  });

  it("safely rejects a case without a persisted lead fact", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: null,
      status: "HUMAN_INVESTIGATION_REQUIRED",
      active: true,
    });

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId);

    expect(result.status).toBe("MISSING_LEAD_FACT");
    expect(generateMock).not.toHaveBeenCalled();
    expect(createAndDispatchMock).not.toHaveBeenCalled();
    expect(db._getCurrentRow().status).toBe("HUMAN_INVESTIGATION_REQUIRED");
  });

  it("returns ALREADY_DECIDED idempotently if case is already DECISION_READY", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: sampleLeadFact,
      status: "DECISION_READY",
      decision_id: "dec-12345",
      ai_recommendation: { recommended_action: "ADD_VEHICLE" },
      active: true,
    });

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId);

    expect(result.status).toBe("ALREADY_DECIDED");
    expect((result as any).decisionId).toBe("dec-12345");
    expect(generateMock).not.toHaveBeenCalled();
    expect(createAndDispatchMock).not.toHaveBeenCalled();
  });

  it("rejects cases in non-recoverable statuses such as FACT_REQUESTED", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: null,
      status: "FACT_REQUESTED",
      active: true,
    });

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId);

    expect(result.status).toBe("NOT_IN_RECOVERABLE_STATE");
    expect((result as any).currentStatus).toBe("FACT_REQUESTED");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns CASE_NOT_FOUND if case does not exist", async () => {
    const db = createMockDb(null);
    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision("00000000-0000-0000-0000-000000000000");

    expect(result.status).toBe("CASE_NOT_FOUND");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("preserves case in recoverable state when AI provider fails", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: sampleLeadFact,
      status: "HUMAN_INVESTIGATION_REQUIRED",
      active: true,
    });

    generateMock.mockRejectedValue(new Error("Rate limit exceeded (429)"));

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId);

    expect(result.status).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect((result as any).error).toContain("Rate limit exceeded");

    const updated = db._getCurrentRow();
    expect(updated.status).toBe("HUMAN_INVESTIGATION_REQUIRED");

    const events = db._getEvents();
    expect(events.map((e: any) => e.event_type)).toContain("AI_DECISION_FAILED");
    expect(createAndDispatchMock).not.toHaveBeenCalled();
  });

  it("preserves case in HUMAN_INVESTIGATION_REQUIRED when critic rejects invalid action", async () => {
    const db = createMockDb({
      id: caseId,
      warehouse_id: "WH-YBA",
      warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: sampleLeadFact,
      status: "HUMAN_INVESTIGATION_REQUIRED",
      active: true,
    });

    const hallucinatedRecommendation = JSON.stringify({
      decision_case_id: caseId,
      recommended_action: "FABRICATED_ACTION",
      confidence: 0.9,
      reason_summary: "Hallucinated",
      current_risk: "Risk",
      expected_state_if_no_action: "Bad",
      expected_state_if_action: "Good",
      key_evidence: ["incident:123"],
      uncertainties: [],
      execution_instruction: "Do it",
      required_by: "2026-09-16T12:00:00.000Z",
      required_followup_at: "2026-09-16T14:00:00.000Z",
      estimated_cost_vnd: null,
      estimated_saving_vnd: null,
    });

    generateMock.mockResolvedValue({ text: hallucinatedRecommendation, model: "gpt-4o" });

    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId);

    expect(result.status).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.criticVerdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(createAndDispatchMock).not.toHaveBeenCalled();

    const updated = db._getCurrentRow();
    expect(updated.status).toBe("HUMAN_INVESTIGATION_REQUIRED");
  });
});

describe("Internal resume API endpoint", () => {
  const caseId = "e2524b83-4462-4238-8914-cd371ab51106";

  beforeEach(() => {
    vi.clearAllMocks();
    isCron.mockReturnValue(false);
  });

  it("rejects unauthenticated requests before querying database", async () => {
    authorize.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const request = new NextRequest("https://example.test/api/internal/near-term-capacity/resume", {
      method: "POST",
      body: JSON.stringify({ caseId }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("rejects malformed or missing caseId", async () => {
    isCron.mockReturnValue(true);

    const invalidUuidRequest = new NextRequest("https://example.test/api/internal/near-term-capacity/resume", {
      method: "POST",
      body: JSON.stringify({ caseId: "not-a-valid-uuid" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(invalidUuidRequest);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("INVALID_CASE_ID");
  });
});
