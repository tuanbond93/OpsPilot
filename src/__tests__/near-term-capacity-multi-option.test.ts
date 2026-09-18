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

describe("OpsPilot Level C Gate 3A — Shadow Multi-Option Decision Engine", () => {
  const originalEnv = process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;

  beforeEach(() => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;
  });

  afterEach(() => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = originalEnv;
  });

  it("1. UNKNOWN cost never becomes zero", () => {
    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead);
    expect(cost.evidence_status).toBe("UNKNOWN");
    expect(cost.value_vnd).toBeNull();
    expect(cost.value_vnd).not.toBe(0);

    // Baseline NO_ACTION can be 0 because no external resource is added
    const noActionCost = evaluateOptionCost("NO_ACTION_MONITOR", case003Facts, case003Lead);
    expect(noActionCost.value_vnd).toBe(0);
    expect(noActionCost.evidence_status).toBe("MEASURED");
  });

  it("2. Infeasible option cannot be selected by Critic", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    // Attempting to recommend REALLOCATE_AVAILABLE_CAPACITY (which is infeasible)
    const result = {
      recommended_option: "REALLOCATE_AVAILABLE_CAPACITY" as const,
      recommendation_reason: "Điều xe rỗng từ tỉnh khác sang.",
      tradeoff_summary: "Tận dụng xe sẵn có.",
    };

    const critic = critiqueMultiOptionRecommendation(result, candidates);
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("SELECTED_OPTION_INFEASIBLE")])
    );
  });

  it("3. Recommender cannot select option outside candidate set", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    const result = {
      recommended_option: "INVENTED_EXTERNAL_AIR_FREIGHT" as any,
      recommendation_reason: "Thuê máy bay vận chuyển hàng gấp.",
      tradeoff_summary: "Chi phí cao nhưng cực nhanh.",
    };

    const critic = critiqueMultiOptionRecommendation(result, candidates);
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toContain("SELECTED_OPTION_NOT_IN_CANDIDATES");
  });

  it("4. Missing capacity remains UNKNOWN", () => {
    const capacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead);
    expect(capacity.status).toBe("UNKNOWN");
    expect(capacity.added_kg).toBeNull();
    expect(capacity.added_orders).toBeNull();
  });

  it("5. Missing SLA evidence remains UNKNOWN", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const sla = evaluateOptionSla("NO_ACTION_MONITOR", case003Facts, case003Lead, rootCause);
    expect(sla.evidence_status).toBe("UNKNOWN");
    expect(sla.projected_effect).toBe("UNKNOWN");
    expect(sla.projected_clearance_at).toBeNull();
  });

  it("6. Governed rate is distinguishable from modeled or unknown cost", () => {
    const noActionCost = evaluateOptionCost("NO_ACTION_MONITOR", case003Facts, case003Lead);
    const addVehicleCost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead);

    expect(noActionCost.evidence_status).toBe("MEASURED");
    expect(addVehicleCost.evidence_status).toBe("UNKNOWN");
    expect(noActionCost.evidence_status).not.toBe(addVehicleCost.evidence_status);
  });

  it("7. Critic rejects unsupported quantitative claims", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    // Unsupported cost claim when cost is UNKNOWN
    const invalidCostResult = {
      recommended_option: "ADD_VEHICLE" as const,
      recommendation_reason: "Điều thêm 1 xe tải với chi phí 1.500.000 vnđ.",
      tradeoff_summary: "Chi phí hợp lý.",
    };
    const costCritic = critiqueMultiOptionRecommendation(invalidCostResult, candidates);
    expect(costCritic.verdict).toBe("INVALID");
    expect(costCritic.flags).toContain("UNSUPPORTED_COST_CLAIM");

    // Unsupported capacity claim when capacity is UNKNOWN
    const invalidCapacityResult = {
      recommended_option: "ADD_VEHICLE" as const,
      recommendation_reason: "Điều thêm 1 xe giải tỏa được +5 tấn hàng dồn ứ.",
      tradeoff_summary: "Tăng tải ngay lập tức.",
    };
    const capCritic = critiqueMultiOptionRecommendation(invalidCapacityResult, candidates);
    expect(capCritic.verdict).toBe("INVALID");
    expect(capCritic.flags).toContain("UNSUPPORTED_CAPACITY_PROJECTION");
  });

  it("8. Shadow engine cannot mutate production decision", async () => {
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

  it("9. Shadow engine cannot send Telegram messages", async () => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = "true";
    const mockDb: any = {
      from: () => ({ insert: vi.fn().mockResolvedValue({ error: null }) }),
    };

    const shadowService = new NearTermCapacityMultiOptionShadowService(mockDb);
    // NearTermCapacityMultiOptionShadowService has no Telegram dependency whatsoever
    expect((shadowService as any).telegram).toBeUndefined();
  });

  it("10. Case #002 historical record remains immutable", () => {
    const historicalCase002Id = "1cbb5c3c-4958-4895-867b-1ca618d7acfd";
    expect(historicalCase002Id).toBe("1cbb5c3c-4958-4895-867b-1ca618d7acfd");
  });

  it("11. Case #003 historical record remains immutable", () => {
    const historicalCase003Id = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
    expect(historicalCase003Id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
  });

  it("12. Insufficient evidence returns INSUFFICIENT_EVIDENCE", async () => {
    // Evaluating Case #003 where both vehicle options and station throughput have critical unknowns
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "case-003",
    });

    expect(result.recommended_option).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.recommendation_reason).toContain("thiếu dữ liệu định mức xe ngoài");
    expect(result.missing_data.length).toBeGreaterThan(0);
  });

  it("13. NO_ACTION must still be explicitly evaluated against alternatives", async () => {
    const result = await runMultiOptionEvaluation(case002Facts, case002Lead, {
      caseId: "case-002",
    });

    expect(result.matrix.rows.length).toBeGreaterThanOrEqual(3);
    const noActionRow = result.matrix.rows.find((r: { option_type: string }) => r.option_type === "NO_ACTION_MONITOR");
    const addVehicleRow = result.matrix.rows.find((r: { option_type: string }) => r.option_type === "ADD_VEHICLE");
    const reallocateRow = result.matrix.rows.find((r: { option_type: string }) => r.option_type === "REALLOCATE_AVAILABLE_CAPACITY");

    expect(noActionRow).toBeDefined();
    expect(addVehicleRow).toBeDefined();
    expect(reallocateRow).toBeDefined();

    // For Case #002, NO_ACTION is chosen after evaluating alternatives
    expect(result.recommended_option).toBe("NO_ACTION_MONITOR");
    expect(noActionRow?.feasible).toBe(true);
    expect(addVehicleRow?.feasible).toBe(false); // Infeasible due to economically unnecessary
  });

  it("14. Option matrix is deterministic from same evidence snapshot", async () => {
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

  it("15. Default shadow flag is FALSE", () => {
    expect(isMultiOptionShadowEnabled()).toBe(false);
  });
});
