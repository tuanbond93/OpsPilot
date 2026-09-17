import { describe, expect, it, vi, beforeEach } from "vitest";
import { NearTermCapacityShadowService, type ShadowCandidateInput } from "@/services/near-term-capacity-shadow";
import * as aiProvider from "@/ai/provider";
import fs from "node:fs";

describe("Near-Term Capacity Policy B Shadow & Historical Replay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockCandidate: ShadowCandidateInput = {
    checkpointAt: "2026-09-16T01:00:00.000Z",
    syncRunId: "5ed84251-b5d6-4e54-bff8-c5872cd5b901",
    incidentKey: "21153000:KHO_TON",
    warehouse: "Kho Giao Hàng Nặng - TP Hạ Long - Quảng Ninh",
    warehouseId: "21153000",
    province: "Quảng Ninh",
    affectedOrderCount: 44,
    currentKg: null, // UNKNOWN != ZERO
    evidenceRefs: ["incident:21153000:KHO_TON", "sync_run:5ed84251-b5d6-4e54-bff8-c5872cd5b901"],
    riskSignals: ["KHO_TON"],
  };

  it("1 & 2 & 3: proves shadow evaluation does not create governed cases, executable decisions, or Telegram requests", async () => {
    const insertedTables: string[] = [];
    const mockDb = {
      from: vi.fn((table: string) => {
        insertedTables.push(table);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            order: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          }),
          upsert: async () => ({ data: null, error: null }),
          insert: async () => ({ data: null, error: null }),
        };
      }),
    } as any;

    vi.spyOn(aiProvider, "generate").mockResolvedValue({
      text: JSON.stringify({
        decision_case_id: "shadow-test",
        recommended_action: "NO_ACTION_MONITOR",
        confidence: 0.85,
        reason_summary: "Backlog within manageable limits; monitor shift progress.",
        current_risk: "Tồn kho: 44 đơn; khối lượng: CHƯA CÓ DỮ LIỆU.",
        expected_state_if_no_action: "Relieved across standard shifts.",
        expected_state_if_action: "SLA remains stable.",
        key_evidence: mockCandidate.evidenceRefs,
        uncertainties: [],
        estimated_cost_vnd: null,
        estimated_saving_vnd: null,
        required_by: "2026-09-16T03:00:00.000Z",
        required_followup_at: "2026-09-16T05:00:00.000Z",
      }),
      model: "gemini-flash-lite-latest",
    });

    const service = new NearTermCapacityShadowService(mockDb);
    const result = await service.observeLiveCandidate(mockCandidate);

    expect(result.shadow_status).toBe("CRITIC_PASSED");
    // Assert strictly observational: never writes to production governed tables
    expect(insertedTables).not.toContain("near_term_capacity_cases");
    expect(insertedTables).not.toContain("decisions");
    expect(insertedTables).not.toContain("telegram_decision_requests");
  });

  it("4: proves shadow ignores the global active-case production lock", async () => {
    // Database has an active case in near_term_capacity_cases
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === "near_term_capacity_cases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "golden-case", active: true, status: "DECISION_READY" },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          upsert: async () => ({ data: null, error: null }),
        };
      }),
    } as any;

    vi.spyOn(aiProvider, "generate").mockResolvedValue({
      text: JSON.stringify({
        decision_case_id: "shadow-test-2",
        recommended_action: "NO_ACTION_MONITOR",
        confidence: 0.8,
        reason_summary: "Normal shift operations suffice.",
        key_evidence: mockCandidate.evidenceRefs,
        required_by: "2026-09-16T03:00:00.000Z",
        required_followup_at: "2026-09-16T05:00:00.000Z",
      }),
      model: "gemini-flash-lite-latest",
    });

    const service = new NearTermCapacityShadowService(mockDb);
    // Even though an active case exists globally, shadow candidate evaluates without error
    const record = await service.observeLiveCandidate({
      ...mockCandidate,
      incidentKey: "different-warehouse:KHO_TON",
    });

    expect(record).toBeDefined();
    expect(record.shadow_status).toBe("CRITIC_PASSED");
    expect(record.source_mode).toBe("LIVE_SHADOW");
  });

  it("5: proves historical replay prevents future-data leakage", async () => {
    let capturedPrompt = "";
    vi.spyOn(aiProvider, "generate").mockImplementation(async (promptText: string) => {
      capturedPrompt = promptText;
      return {
        text: JSON.stringify({
          decision_case_id: "replay-test",
          recommended_action: "NO_ACTION_MONITOR",
          confidence: 0.85,
          reason_summary: "Replay at historical timestamp",
          key_evidence: mockCandidate.evidenceRefs,
          required_by: "2026-09-16T03:00:00.000Z",
          required_followup_at: "2026-09-16T05:00:00.000Z",
        }),
        model: "gemini-flash-lite-latest",
      };
    });

    const mockDb = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          gt: () => ({
            order: () => ({
              limit: async () => ({
                data: [{ affected_order_count: 20, recorded_at: "2026-09-16T04:00:00.000Z" }],
                error: null,
              }),
            }),
          }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    } as any;

    const service = new NearTermCapacityShadowService(mockDb);
    const record = await service.evaluateShadowCandidate(
      { ...mockCandidate, incidentKey: "historical-leakage-test:KHO_TON" },
      "HISTORICAL_REPLAY"
    );

    // AI prompt MUST NOT contain later outcome information (20 orders at 04:00)
    expect(capturedPrompt).not.toContain("2026-09-16T04:00:00.000Z");
    // Outcome backtest is attached separately afterward
    expect(record.outcome_backtest).toBeDefined();
    expect(record.outcome_backtest?.status).toBe("CONSISTENT_WITH_OUTCOME");
    expect(record.source_mode).toBe("HISTORICAL_REPLAY");
  });

  it("6: proves UNKNOWN != ZERO is preserved in shadow prompts and fact status", async () => {
    let capturedPrompt = "";
    vi.spyOn(aiProvider, "generate").mockImplementation(async (promptText: string) => {
      capturedPrompt = promptText;
      return {
        text: JSON.stringify({
          decision_case_id: "semantic-test",
          recommended_action: "NO_ACTION_MONITOR",
          confidence: 0.85,
          reason_summary: "Preserved unknown",
          key_evidence: mockCandidate.evidenceRefs,
          required_by: "2026-09-16T03:00:00.000Z",
          required_followup_at: "2026-09-16T05:00:00.000Z",
        }),
        model: "gemini-flash-lite-latest",
      };
    });

    const mockDb = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          gt: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    } as any;

    const service = new NearTermCapacityShadowService(mockDb);
    const record = await service.evaluateShadowCandidate(
      { ...mockCandidate, currentKg: null, affectedOrderCount: 44, incidentKey: "semantic-check:KHO_TON" },
      "HISTORICAL_REPLAY"
    );

    expect(record.current_kg).toBeNull();
    expect(record.current_kg_status).toBe("UNKNOWN");
    expect(record.current_orders_status).toBe("AVAILABLE");
    // Verify prompt does NOT say "0 kg"
    expect(capturedPrompt).toContain("CHƯA CÓ DỮ LIỆU");
    expect(capturedPrompt).not.toMatch(/0\s*kg/);
  });

  it("7: proves Gemini failure is fail-soft and defaults to HUMAN_INVESTIGATION_REQUIRED", async () => {
    vi.spyOn(aiProvider, "generate").mockRejectedValue(new Error("API_QUOTA_EXCEEDED"));

    const mockDb = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          gt: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    } as any;

    const service = new NearTermCapacityShadowService(mockDb);
    const record = await service.evaluateShadowCandidate(
      { ...mockCandidate, incidentKey: "fail-soft-test:KHO_TON" },
      "HISTORICAL_REPLAY"
    );

    expect(record.shadow_status).toBe("AI_FAILED");
    expect(record.ai_recommended_action).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(record.ai_reason_summary).toContain("fail-soft");
  });

  it("8: proves Critic result and flags are persisted", async () => {
    // Return an intervention that requires volume when volume is missing
    vi.spyOn(aiProvider, "generate").mockResolvedValue({
      text: JSON.stringify({
        decision_case_id: "critic-flags-test",
        recommended_action: "ADD_VEHICLE", // Requires known volume
        confidence: 0.9,
        reason_summary: "Heavy backlog needs truck",
        key_evidence: mockCandidate.evidenceRefs,
        required_by: "2026-09-16T03:00:00.000Z",
        required_followup_at: "2026-09-16T05:00:00.000Z",
      }),
      model: "gemini-flash-lite-latest",
    });

    const mockDb = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          gt: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    } as any;

    const service = new NearTermCapacityShadowService(mockDb);
    const record = await service.evaluateShadowCandidate(
      { ...mockCandidate, currentKg: null, incidentKey: "critic-flags-test:KHO_TON" },
      "HISTORICAL_REPLAY"
    );

    expect(record.critic_verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(record.critic_flags).toContain("INTERVENTION_ACTION_REQUIRES_KNOWN_VOLUME");
    expect(record.shadow_status).toBe("CRITIC_FAILED");
    expect(record.provisional_label).toBe("INSUFFICIENT_DATA");
  });

  it("9 & 10: proves live shadow and historical replay are distinctly tagged and duplicate candidate replay is idempotent", async () => {
    let callCount = 0;
    vi.spyOn(aiProvider, "generate").mockImplementation(async () => {
      callCount += 1;
      return {
        text: JSON.stringify({
          decision_case_id: "idempotency-test",
          recommended_action: "NO_ACTION_MONITOR",
          confidence: 0.85,
          reason_summary: "Idempotent evaluation",
          key_evidence: mockCandidate.evidenceRefs,
          required_by: "2026-09-16T03:00:00.000Z",
          required_followup_at: "2026-09-16T05:00:00.000Z",
        }),
        model: "gemini-flash-lite-latest",
      };
    });

    const mockDb = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          gt: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    } as any;

    const service = new NearTermCapacityShadowService(mockDb);

    // Call replay twice with identical candidate
    const replay1 = await service.evaluateShadowCandidate(
      { ...mockCandidate, incidentKey: "idempotent-candidate:KHO_TON" },
      "HISTORICAL_REPLAY"
    );
    const replay2 = await service.evaluateShadowCandidate(
      { ...mockCandidate, incidentKey: "idempotent-candidate:KHO_TON" },
      "HISTORICAL_REPLAY"
    );

    // Call live shadow
    const live = await service.evaluateShadowCandidate(
      { ...mockCandidate, incidentKey: "idempotent-candidate:KHO_TON" },
      "LIVE_SHADOW"
    );

    expect(replay1.source_mode).toBe("HISTORICAL_REPLAY");
    expect(live.source_mode).toBe("LIVE_SHADOW");
    expect(replay1.shadow_id).toBe(replay2.shadow_id);
    // Duplicate historical replay was served from idempotency cache:
    expect(callCount).toBe(2); // 1 for replay, 1 for live shadow (distinct mode)
  });

  it("keeps migration 076 server-only with immutable trigger and RLS", () => {
    const sql = fs.readFileSync("src/database/migrations/076_near_term_capacity_shadow_decisions.sql", "utf8");
    expect(sql).toContain("near_term_capacity_shadow_decisions");
    expect(sql).toContain("ALTER TABLE public.near_term_capacity_shadow_decisions ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE TRIGGER trg_near_term_capacity_shadow_immutable");
    expect(sql).toContain("reject_near_term_capacity_shadow_mutation");
    expect(sql).not.toMatch(/CREATE\s+POLICY|USING\s*\(\s*true\s*\)|WITH\s+CHECK\s*\(\s*true\s*\)/i);
  });
});
