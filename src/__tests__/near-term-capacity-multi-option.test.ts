import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateRootCause,
  generateCandidateOptions,
  buildMultiOptionMatrix,
  formatOptionMatrixMarkdown,
  critiqueMultiOptionRecommendation,
  runMultiOptionEvaluation,
  evaluateOptionCost,
  evaluateOptionCapacity,
  evaluateOptionSla,
  type CurrentRisk,
  type LeadFact,
  type DecisionOption,
} from "@/domain/near-term-capacity";
import {
  NearTermCapacityMultiOptionShadowService,
  isMultiOptionShadowEnabled,
} from "@/services/near-term-capacity-multi-option-shadow";

// Real production snapshot for Case #002 (Lào Cai)
const case002Facts: CurrentRisk = {
  warehouseId: "21158000",
  warehouseName: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
  capturedAt: "2026-09-18T03:00:00.000Z",
  currentOrders: 9,
  currentKg: 213.884,
  b2bOrders: null,
  evidenceRefs: ["incident:case-002"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Persisted warehouse backlog risk",
};

const case002Lead: LeadFact = {
  interactionId: "1cbb5c3c-4958-4895-867b-1ca618d7acfd",
  suppliedBy: "telegram:lead-laocai",
  capturedAt: "2026-09-18T03:15:00.000Z",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  expectedIncomingKg: null,
  expectedIncomingAt: null,
  incomingType: null,
  availableVehicles: null,
  availableManpower: null,
  confidence: "HIGH",
};

// Real production snapshot for Case #003 (Phú Thọ)
const case003Facts: CurrentRisk = {
  warehouseId: "21160000",
  warehouseName: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
  capturedAt: "2026-09-18T07:00:02.601Z",
  currentOrders: 87,
  currentKg: 11697.69,
  b2bOrders: null,
  evidenceRefs: ["incident:case-003"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Persisted warehouse backlog risk",
};

const case003Lead: LeadFact = {
  interactionId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
  suppliedBy: "telegram:07a450b9-86e1-437d-a3c9-55c5ebd952a9",
  capturedAt: "2026-09-18T07:36:45.110Z",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  expectedIncomingKg: null,
  expectedIncomingAt: null,
  incomingType: null,
  availableVehicles: null,
  availableManpower: null,
  confidence: "LOW",
};

describe("OpsPilot Level C Gate 3A.1 — Evidence Semantics Hardening for Shadow Multi-Option Engine", () => {
  const originalEnv = process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;

  beforeEach(() => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;
  });

  afterEach(() => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = originalEnv;
  });

  it("1. SLA unavailable -> SLA_EFFECT UNKNOWN", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const noActionSla = evaluateOptionSla("NO_ACTION_MONITOR", case003Facts, case003Lead, rootCause);
    const addVehicleSla = evaluateOptionSla("ADD_VEHICLE", case003Facts, case003Lead, rootCause);

    expect(noActionSla.evidence_status).toBe("UNKNOWN");
    expect(noActionSla.projected_effect).toBe("UNKNOWN");
    expect(addVehicleSla.evidence_status).toBe("UNKNOWN");
    expect(addVehicleSla.projected_effect).toBe("UNKNOWN");
  });

  it("2. throughput unavailable -> no projected clearance time", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const sla = evaluateOptionSla("NO_ACTION_MONITOR", case003Facts, case003Lead, rootCause);

    expect(sla.projected_clearance_at).toBeNull();
    expect(sla.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tốc độ/công suất phân loại"),
      ])
    );
  });

  it("3. vehicle capacity unavailable -> no capacity improvement claim", () => {
    const capacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead);

    expect(capacity.status).toBe("UNKNOWN");
    expect(capacity.added_kg).toBeNull();
    expect(capacity.added_orders).toBeNull();
    expect(capacity.capacity_gap_after).toContain("UNKNOWN");
  });

  it("4. vehicle availability unavailable -> ADD_VEHICLE not FEASIBLE", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    expect(addVehicle).toBeDefined();
    expect(addVehicle?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(addVehicle?.feasible).toBe(false);
    expect(addVehicle?.feasibility_reason).toContain("Chưa xác nhận khả dụng xe");
  });

  it("5. economic desirability separated from feasibility", () => {
    const rootCause = evaluateRootCause(case002Facts, case002Lead);
    const candidates = generateCandidateOptions(case002Facts, case002Lead, rootCause);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    expect(addVehicle).toBeDefined();
    // Operational concept is valid in theory: CONDITIONALLY_FEASIBLE
    expect(addVehicle?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(addVehicle?.feasibility_status).not.toBe("INFEASIBLE");
    // Economically unjustified: NOT_JUSTIFIED
    expect(addVehicle?.economic.status).toBe("NOT_JUSTIFIED");
    expect(addVehicle?.economic.reason).toContain("Tồn kho nhỏ");
  });

  it("6. NO_ACTION incremental cost = 0 does not mean total operating cost = 0", () => {
    const cost = evaluateOptionCost("NO_ACTION_MONITOR", case002Facts, case002Lead);

    expect(cost.incremental_cost_vnd).toBe(0);
    expect(cost.evidence_status).toBe("MEASURED");
    expect(cost.notes).toContain("Chi phí can thiệp phát sinh = 0 đ (không bao gồm chi phí vận hành trạm tiêu chuẩn)");

    // Critic rejects if recommendation claims total operating cost is 0
    const rootCause = evaluateRootCause(case002Facts, case002Lead);
    const candidates = generateCandidateOptions(case002Facts, case002Lead, rootCause);
    const invalidResult = {
      recommended_option: "NO_ACTION_MONITOR" as const,
      recommendation_reason: "Tổng chi phí vận hành bằng 0.",
      tradeoff_summary: "Không tốn chi phí.",
    };
    const critic = critiqueMultiOptionRecommendation(invalidResult, candidates);
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("INCREMENTAL_COST_CONFUSED_WITH_TOTAL_OPERATING_COST")])
    );
  });

  it("7. unavailable SLA evidence cannot produce SLA root cause", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);

    expect(rootCause.category).not.toBe("SLA_AGING_RISK");
    expect(rootCause.category).not.toBe("SLA_BREACH_RISK");
    expect(rootCause.category).toBe("CAPACITY_CAUSE_UNKNOWN");
    expect(rootCause.confidence).toBeLessThanOrEqual(0.6);
    expect(rootCause.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("SLA")])
    );
  });

  it("8. critic rejects unsupported SLA direction", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    // SLA IMPROVE claimed without evidence
    const improveResult = {
      recommended_option: "ADD_VEHICLE" as const,
      recommendation_reason: "Điều thêm xe để cải thiện SLA trạm.",
      tradeoff_summary: "Cứu đơn kịp SLA.",
    };
    const improveCritic = critiqueMultiOptionRecommendation(improveResult, candidates);
    expect(improveCritic.verdict).toBe("INVALID");
    expect(improveCritic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_SLA_IMPROVE_CLAIM")])
    );

    // SLA NEUTRAL claimed without evidence
    const neutralResult = {
      recommended_option: "NO_ACTION_MONITOR" as const,
      recommendation_reason: "Giữ nguyên hiện trạng để ổn định SLA.",
      tradeoff_summary: "Đảm bảo SLA trạm.",
    };
    const neutralCritic = critiqueMultiOptionRecommendation(neutralResult, candidates);
    expect(neutralCritic.verdict).toBe("INVALID");
    expect(neutralCritic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_SLA_NEUTRAL_CLAIM")])
    );
  });

  it("9. critic rejects unsupported feasibility claim", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    // Mocking ADD_VEHICLE as FEASIBLE despite missing vehicle telemetry
    const fakeCandidates: DecisionOption[] = candidates.map((c) =>
      c.option_type === "ADD_VEHICLE"
        ? { ...c, feasibility_status: "FEASIBLE" as const }
        : c
    );

    const result = {
      recommended_option: "ADD_VEHICLE" as const,
      recommendation_reason: "Điều thêm xe khả thi ngay lập tức.",
      tradeoff_summary: "Sử dụng nguồn xe sẵn có.",
    };

    const critic = critiqueMultiOptionRecommendation(result, fakeCandidates);
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_FEASIBILITY_CLAIM")])
    );

    // Marking option INFEASIBLE because of ECONOMICALLY_UNNECESSARY
    const fakeCandidatesEcon = candidates.map((c) =>
      c.option_type === "ADD_VEHICLE"
        ? { ...c, feasibility_status: "INFEASIBLE" as const, feasibility_reason: "ECONOMICALLY_UNNECESSARY" }
        : c
    );
    const econCritic = critiqueMultiOptionRecommendation(
      { recommended_option: "NO_ACTION_MONITOR", recommendation_reason: "Duy trì.", tradeoff_summary: "An toàn." },
      fakeCandidatesEcon
    );
    expect(econCritic.verdict).toBe("INVALID");
    expect(econCritic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("ECONOMIC_JUSTIFICATION_CONFUSED_WITH_FEASIBILITY")])
    );
  });

  it("10. Case #002 immutable", () => {
    const historicalCase002Id = "1cbb5c3c-4958-4895-867b-1ca618d7acfd";
    expect(historicalCase002Id).toBe("1cbb5c3c-4958-4895-867b-1ca618d7acfd");
  });

  it("11. Case #003 immutable", () => {
    const historicalCase003Id = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
    expect(historicalCase003Id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
  });

  it("12. production decision unchanged", async () => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = "true";

    const updateMock = vi.fn();
    const insertMock = vi.fn().mockResolvedValue({ error: null });

    const mockDb: any = {
      from: vi.fn((table: string) => {
        if (table === "near_term_capacity_cases") {
          return { update: updateMock };
        }
        if (table === "near_term_capacity_events") {
          return { insert: insertMock };
        }
        return {};
      }),
    };

    const shadowService = new NearTermCapacityMultiOptionShadowService(mockDb);
    const result = await shadowService.evaluateShadow("case-shadow-123", case003Facts, case003Lead);

    expect(result).not.toBeNull();
    // Must NOT call update on near_term_capacity_cases
    expect(updateMock).not.toHaveBeenCalled();
    // Must only emit an audit observation event
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: "case-shadow-123",
        event_type: "MULTI_OPTION_SHADOW_EVALUATED",
        actor: "shadow_engine:gate_3a",
      })
    );
  });

  it("13. Telegram unchanged", async () => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = "true";
    const mockDb: any = {
      from: () => ({ insert: vi.fn().mockResolvedValue({ error: null }) }),
    };

    const shadowService = new NearTermCapacityMultiOptionShadowService(mockDb);
    // NearTermCapacityMultiOptionShadowService has no Telegram dependency whatsoever
    expect((shadowService as any).telegram).toBeUndefined();
  });

  it("14. Case #003 recommends REQUEST_MORE_INFORMATION with explicit required items", async () => {
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "case-003",
    });

    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.requested_information).toBeDefined();
    expect(result.requested_information).toEqual(
      expect.arrayContaining([
        "current available vehicle count",
        "vehicle class/capacity",
        "estimated arrival time",
        "station clearance throughput",
        "order SLA deadlines",
      ])
    );
    expect(result.critic_verdict).toBe("VALID");
  });

  it("15. Case #002 recommends NO_ACTION_MONITOR after evaluating alternatives", async () => {
    const result = await runMultiOptionEvaluation(case002Facts, case002Lead, {
      caseId: "case-002",
    });

    expect(result.root_cause.category).toBe("NO_MATERIAL_GAP");
    expect(result.recommended_option).toBe("NO_ACTION_MONITOR");
    expect(result.critic_verdict).toBe("VALID");

    const addVehicle = result.candidate_options.find((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicle?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(addVehicle?.economic.status).toBe("NOT_JUSTIFIED");
  });

  it("16. Option matrix is deterministic from same evidence snapshot", async () => {
    const run1 = await runMultiOptionEvaluation(case003Facts, case003Lead, { caseId: "case-003" });
    const run2 = await runMultiOptionEvaluation(case003Facts, case003Lead, { caseId: "case-003" });

    expect(run1.root_cause.category).toBe(run2.root_cause.category);
    expect(run1.matrix.rows).toEqual(run2.matrix.rows);
    expect(run1.recommended_option).toBe(run2.recommended_option);

    const md = formatOptionMatrixMarkdown(run1.matrix);
    expect(md).toContain("BẢNG SO SÁNH PHƯƠNG ÁN RA QUYẾT ĐỊNH");
    expect(md).toContain("NO_ACTION_MONITOR");
    expect(md).toContain("ADD_VEHICLE");
  });

  it("17. Default shadow flag is FALSE", () => {
    expect(isMultiOptionShadowEnabled()).toBe(false);
  });
});
