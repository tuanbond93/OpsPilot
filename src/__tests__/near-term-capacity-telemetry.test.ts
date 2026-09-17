import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";

describe("near-term capacity detector telemetry", () => {
  it("keeps telemetry server-only, bounded, and indexed", () => {
    const sql = fs.readFileSync("src/database/migrations/074_near_term_capacity_detector_telemetry.sql", "utf8");
    expect(sql).toContain("near_term_capacity_checkpoint_telemetry");
    expect(sql).toContain("near_term_capacity_detector_telemetry");
    expect(sql).toContain("ALTER TABLE public.near_term_capacity_checkpoint_telemetry ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.near_term_capacity_detector_telemetry ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("idx_near_term_capacity_detector_telemetry_result");
    expect(sql).not.toMatch(/CREATE\s+POLICY|USING\s*\(\s*true\s*\)|WITH\s+CHECK\s*\(\s*true\s*\)/i);
  });

  it("records a zero-candidate rejection batch without changing the result", async () => {
    const telemetryWrites: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      if (table === "incidents") return { select: () => ({ in: () => ({ eq: () => ({ order: async () => ({ data: [{ id: "i-1", incident_key: "1141:KHO_TON", warehouse_id: "1141", warehouse_name: "Kho Trung Chuyển Đà Nẵng", reason_code: "KHO_TON", last_detected_at: new Date().toISOString() }], error: null }) }) }) }) };
      if (table === "telegram_pilot_members") return { select: () => ({ eq: async () => ({ data: [{ id: "member-1", group_id: "group-1", telegram_user_id: 1, display_name: "Lead", username: null, role: "LEAD", status: "ACTIVE", private_chat_id: null, onboarding_state: "UNKNOWN" }], error: null }) }) };
      if (table === "telegram_user_scopes") return { select: () => ({ in: () => ({ eq: async () => ({ data: [{ id: "scope-1", member_id: "member-1", scope_type: "REGION", scope_code: "Miền Trung", permission: "MANAGE_SCOPE", active: true }], error: null }) }) }) };
      if (table === "incident_history") return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
      if (table.includes("telemetry")) return { upsert: async (payload: Record<string, unknown>) => { telemetryWrites.push({ table, payload }); return { error: null }; } };
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await new NearTermCapacityRuntimeService({ from } as any).runCheckpoint("test", { checkpointAt: "2026-09-15T11:00:00.000Z", syncRunId: "123e4567-e89b-42d3-a456-426614174000" });
    expect(result).toMatchObject({ status: "NO_CANDIDATE", risk_candidates: 0, fact_requests_sent: 0 });
    expect(telemetryWrites.map((item) => item.table)).toEqual(expect.arrayContaining(["near_term_capacity_detector_telemetry", "near_term_capacity_checkpoint_telemetry"]));
    expect(telemetryWrites.find((item) => item.table.includes("detector"))?.payload).toMatchObject({ detector_result: "REJECTED", rejection_reason: "MISSING_REQUIRED_SIGNAL", current_orders_availability: "MISSING" });
    expect(telemetryWrites.find((item) => item.table.includes("checkpoint"))?.payload).toMatchObject({ incidents_scanned: 1, candidates_detected: 0, rejected_count: 1, missing_signal_count: 1 });
  });

  it("isolates telemetry write failures from the existing checkpoint result", async () => {
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "existing", active: true }, error: null }) }) }) };
      if (table.includes("telemetry")) return { upsert: async () => { throw new Error("telemetry unavailable"); } };
      throw new Error(`Unexpected table ${table}`);
    });
    await expect(new NearTermCapacityRuntimeService({ from } as any).runCheckpoint("test", { checkpointAt: "2026-09-15T11:00:00.000Z", syncRunId: "123e4567-e89b-42d3-a456-426614174000" })).resolves.toMatchObject({ status: "ACTIVE_CASE_EXISTS", fact_requests_sent: 0 });
  });
});

import { computeEvidenceMetrics, explainAuditRootCauses } from "@/services/near-term-capacity-evidence";

describe("evidence telemetry integrity and invariants", () => {
  it("proves eligible_cases cannot be less than distinct decisions", () => {
    const metrics = computeEvidenceMetrics({
      allCases: [{ id: "case-1", decision_id: "dec-1", active: true }],
      allEvents: [
        { case_id: "case-1", event_type: "AI_DECISION_CREATED" },
        { case_id: "case-2", event_type: "AI_DECISION_CREATED" }, // Another decision was created
      ],
      allRequests: [],
      allDecisions: [
        { id: "dec-1", source_type: "NEAR_TERM_CAPACITY" },
        { id: "dec-2", source_type: "NEAR_TERM_CAPACITY" },
      ],
      allFacts: [],
      eligibleCasesCount: 1, // Stale count of 1
    });

    expect(metrics.eligible_cases).toBeGreaterThanOrEqual(metrics.gemini_decisions);
  });

  it("proves manager_cards_delivered cannot exceed distinct manager requests for the scoped cohort", () => {
    const metrics = computeEvidenceMetrics({
      allCases: [{ id: "case-golden", decision_id: "dec-golden", active: true }],
      allEvents: [{ case_id: "case-golden", event_type: "AI_DECISION_CREATED" }],
      allRequests: [
        { id: "req-1", capacity_case_id: "case-golden", status: "SENT" },
        // Foreign requests from other systems / historical sprints:
        { id: "req-foreign-1", capacity_case_id: null, status: "SENT" },
        { id: "req-foreign-2", capacity_case_id: "unrelated-case", status: "RESPONDED" },
      ],
      allDecisions: [{ id: "dec-golden", source_type: "NEAR_TERM_CAPACITY", decision_status: "READY_FOR_REVIEW" }],
      allFacts: [],
    });

    // Delivered cards must strictly equal 1 (scoped), not 3 (global)
    expect(metrics.manager_cards_delivered).toBe(1);
    expect(metrics.manager_cards_delivered).toBeLessThanOrEqual(1);
  });

  it("proves manager_approved + manager_rejected cannot exceed unique manager requests", () => {
    const metrics = computeEvidenceMetrics({
      allCases: [{ id: "case-golden", decision_id: "dec-golden", active: true }],
      allEvents: [{ case_id: "case-golden", event_type: "AI_DECISION_CREATED" }],
      allRequests: [
        { id: "req-1", capacity_case_id: "case-golden", status: "SENT" },
      ],
      allDecisions: [
        { id: "dec-golden", source_type: "NEAR_TERM_CAPACITY", decision_status: "READY_FOR_REVIEW" },
        // 11 foreign approved decisions in the global decisions table:
        ...Array.from({ length: 11 }, (_, i) => ({
          id: `foreign-dec-${i}`,
          source_type: "FOLLOW_UP_CYCLE",
          decision_status: "APPROVED",
        })),
      ],
      allFacts: [],
    });

    expect(metrics.manager_approved + metrics.manager_rejected).toBeLessThanOrEqual(metrics.manager_cards_delivered);
    expect(metrics.manager_approved).toBe(0);
    expect(metrics.manager_rejected).toBe(0);
  });

  it("proves one Golden Case with one delivered card and no Manager action returns canonical counts", () => {
    const goldenCaseId = "e2524b83-4462-4238-8914-cd371ab51106";
    const goldenDecisionId = "92d8e19c-db9e-4840-891f-a90d5c38df6c";

    const allCases = [
      {
        id: goldenCaseId,
        status: "HUMAN_INVESTIGATION_REQUIRED",
        active: true,
        decision_id: goldenDecisionId,
        warehouse_id: "1141",
        warehouse_name: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
      },
    ];

    const allEvents = [
      { case_id: goldenCaseId, event_type: "FACT_REQUEST_SENT", created_at: "2026-09-17T06:00:00Z" },
      { case_id: goldenCaseId, event_type: "FACT_INITIAL_RESPONSE_RECEIVED", created_at: "2026-09-17T06:30:00Z" },
      { case_id: goldenCaseId, event_type: "FACT_RECEIVED", created_at: "2026-09-17T06:30:01Z" },
      { case_id: goldenCaseId, event_type: "AI_DECISION_RESUME_STARTED", created_at: "2026-09-17T07:00:00Z" },
      {
        case_id: goldenCaseId,
        event_type: "AI_DECISION_CREATED",
        created_at: "2026-09-17T07:00:02Z",
        payload: { critic: { verdict: "VALID_DECISION" } },
      },
      { case_id: goldenCaseId, event_type: "MANAGER_DECISION_CARD_SENT", created_at: "2026-09-17T07:00:08Z" },
    ];

    const allRequests = [
      {
        id: "533661b4-a3d1-407b-8ea9-4ab3e3d5d8a1",
        capacity_case_id: goldenCaseId,
        decision_id: goldenDecisionId,
        status: "SENT",
        telegram_message_id: 1313,
      },
      // 3 foreign requests:
      { id: "foreign-req-1", capacity_case_id: null, status: "SENT" },
      { id: "foreign-req-2", capacity_case_id: null, status: "SENT" },
      { id: "foreign-req-3", capacity_case_id: null, status: "RESPONDED" },
    ];

    const allDecisions = [
      {
        id: goldenDecisionId,
        source_type: "NEAR_TERM_CAPACITY",
        decision_status: "READY_FOR_REVIEW",
        source_links: { capacityCaseId: goldenCaseId },
      },
      // 11 foreign approved decisions:
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `foreign-approved-${i}`,
        source_type: "INCIDENT_TRIAGE",
        decision_status: "APPROVED",
      })),
    ];

    const allFacts = [
      { id: "fact-1", case_id: goldenCaseId, interaction_id: "int-1" },
    ];

    const metrics = computeEvidenceMetrics({
      allCases,
      allEvents,
      allRequests,
      allDecisions,
      allFacts,
      eligibleCasesCount: 1,
    });

    // Exact required assertion from Part 4:
    expect(metrics).toEqual({
      eligible_cases: 1,
      fact_requests: 1,
      fact_responses: 1, // Deduplicated human response entity
      gemini_decisions: 1,
      critic_pass: 1,
      critic_fail: 0,
      manager_cards_delivered: 1,
      manager_approved: 0,
      manager_rejected: 0,
      resolved_cases: 0,
    });

    const rootCauses = explainAuditRootCauses({
      allCases,
      allRequests,
      allDecisions,
      canonicalCards: metrics.manager_cards_delivered,
      canonicalApproved: metrics.manager_approved,
      canonicalFactResponses: metrics.fact_responses,
    });

    expect(rootCauses.manager_cards_4_explanation.reported).toBe(4);
    expect(rootCauses.manager_cards_4_explanation.canonical_near_term_capacity).toBe(1);
    expect(rootCauses.manager_cards_4_explanation.foreign_unscoped_rows_count).toBe(3);

    expect(rootCauses.manager_approved_11_explanation.reported).toBe(11);
    expect(rootCauses.manager_approved_11_explanation.canonical_near_term_capacity).toBe(0);
    expect(rootCauses.manager_approved_11_explanation.foreign_unscoped_rows_count).toBe(11);

    expect(rootCauses.fact_responses_2_explanation.reported).toBe(2);
    expect(rootCauses.fact_responses_2_explanation.canonical_unique_cases).toBe(1);
  });
});
