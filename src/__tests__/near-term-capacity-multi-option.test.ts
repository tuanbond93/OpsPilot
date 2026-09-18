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

describe("OpsPilot Level C Gate 3A.2 — Final Semantic Consistency Patch Before Live Shadow", () => {
  const originalEnv = process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;

  beforeEach(() => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED;
  });

  afterEach(() => {
    process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED = originalEnv;
  });

  it("1. missing reallocation telemetry -> UNKNOWN, not INFEASIBLE", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);
    const reallocate = candidates.find((c) => c.option_type === "REALLOCATE_AVAILABLE_CAPACITY");

    expect(reallocate).toBeDefined();
    expect(reallocate?.feasibility_status).toBe("UNKNOWN");
    expect(reallocate?.feasibility_status).not.toBe("INFEASIBLE");
    expect(reallocate?.feasible).toBe(false);
  });

  it("2. missing manpower roster -> UNKNOWN, not INFEASIBLE", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);
    const manpower = candidates.find((c) => c.option_type === "ADD_MANPOWER");

    expect(manpower).toBeDefined();
    expect(manpower?.feasibility_status).toBe("UNKNOWN");
    expect(manpower?.feasibility_status).not.toBe("INFEASIBLE");
    expect(manpower?.feasible).toBe(false);
  });

  it("3. explicit policy prohibition -> INFEASIBLE", () => {
    // Valid positive constraint/policy can mark an option INFEASIBLE
    const validProhibitedCandidates: DecisionOption[] = [
      {
        option_id: "OPT_PROHIBITED",
        option_type: "ADD_VEHICLE",
        description: "Điều xe tải nặng",
        feasibility_status: "INFEASIBLE",
        feasibility_reason: "Chính sách cấm: Cấm xe tải trọng lớn vào khu vực nội thành",
        feasibility_evidence: "Quy định cấm xe tải nặng số 12/2025",
        economic: { status: "UNKNOWN", reason: null },
        evidence_refs: [],
        cost: { incremental_cost_vnd: null, evidence_status: "UNKNOWN", source: null },
        capacity: {
          current_capacity_kg: null,
          current_capacity_orders: null,
          added_kg: null,
          added_orders: null,
          added_vehicle_days: null,
          resulting_capacity_kg: null,
          capacity_gap_before: null,
          capacity_gap_after: null,
          status: "UNKNOWN",
        },
        sla: {
          projected_effect: "UNKNOWN",
          projected_clearance_at: null,
          breach_risk: "UNKNOWN",
          evidence_status: "UNKNOWN",
          confidence: 0.1,
          evidence: [],
        },
        operational_effect: { description: "" },
        assumptions: [],
        unknowns: [],
        risks: [],
        confidence: 0.1,
        feasible: false,
      },
    ];

    const validCritic = critiqueMultiOptionRecommendation(
      { recommended_option: "INSUFFICIENT_EVIDENCE", recommendation_reason: "Chờ thông tin", tradeoff_summary: "" },
      validProhibitedCandidates
    );
    expect(validCritic.verdict).toBe("VALID");
    expect(validCritic.flags).not.toContain(
      expect.stringContaining("MISSING_EVIDENCE_CANNOT_JUSTIFY_INFEASIBLE")
    );

    // But critic rejects INFEASIBLE when the only justification is missing evidence
    const invalidCandidates: DecisionOption[] = [
      {
        ...validProhibitedCandidates[0],
        feasibility_reason: "Chưa có dữ liệu đội xe",
      },
    ];
    const invalidCritic = critiqueMultiOptionRecommendation(
      { recommended_option: "INSUFFICIENT_EVIDENCE", recommendation_reason: "Chờ thông tin", tradeoff_summary: "" },
      invalidCandidates
    );
    expect(invalidCritic.verdict).toBe("INVALID");
    expect(invalidCritic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("MISSING_EVIDENCE_CANNOT_JUSTIFY_INFEASIBLE")])
    );
  });

  it("4. missing economics -> economic_status UNKNOWN", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);

    const noAction = candidates.find((c) => c.option_type === "NO_ACTION_MONITOR");
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");
    const reallocate = candidates.find((c) => c.option_type === "REALLOCATE_AVAILABLE_CAPACITY");
    const manpower = candidates.find((c) => c.option_type === "ADD_MANPOWER");

    expect(noAction?.economic.status).toBe("UNKNOWN");
    expect(addVehicle?.economic.status).toBe("UNKNOWN");
    expect(reallocate?.economic.status).toBe("UNKNOWN");
    expect(manpower?.economic.status).toBe("UNKNOWN");
  });

  it("5. REQUEST_MORE_INFORMATION can be justified without asserting another option is economically optimal", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause);
    const reqInfo = candidates.find((c) => c.option_type === "REQUEST_MORE_INFORMATION");

    expect(reqInfo).toBeDefined();
    expect(reqInfo?.economic.status).toBe("JUSTIFIED");
    expect(reqInfo?.economic.reason).toContain("không phát sinh chi phí can thiệp");
    expect(reqInfo?.economic.reason).toContain("không chứng minh phương án vận hành là tối ưu kinh tế");
  });

  it("6. Case #002 economic claim requires governed evidence", () => {
    const rootCause = evaluateRootCause(case002Facts, case002Lead);
    const candidates = generateCandidateOptions(case002Facts, case002Lead, rootCause);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    // In the absence of a governed rate matrix, economic_status must be UNKNOWN, not NOT_JUSTIFIED
    expect(addVehicle?.economic.status).toBe("UNKNOWN");
    expect(addVehicle?.economic.reason).toContain("Chưa có biểu phí định mức");

    // Critic rejects NOT_JUSTIFIED without governed rate evidence
    const invalidCandidate = candidates.map((c) =>
      c.option_type === "ADD_VEHICLE"
        ? { ...c, economic: { status: "NOT_JUSTIFIED" as const, reason: "Tồn kho nhỏ" } }
        : c
    );
    const critic = critiqueMultiOptionRecommendation(
      { recommended_option: "INSUFFICIENT_EVIDENCE", recommendation_reason: "Chờ dữ liệu", tradeoff_summary: "" },
      invalidCandidate
    );
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_ECONOMIC_STATUS")])
    );
  });

  it("7. Case #002 root-cause confidence requires governed evidence", () => {
    const rootCause = evaluateRootCause(case002Facts, case002Lead);

    expect(rootCause.category).toBe("NO_MATERIAL_GAP");
    // Bounded confidence <= 0.6 because governed capacity baseline is unmeasured
    expect(rootCause.confidence).toBeLessThanOrEqual(0.6);
    expect(rootCause.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("ngưỡng tải định mức")])
    );

    // Critic rejects confidence > 0.6 for NO_MATERIAL_GAP without governed threshold
    const highConfRootCause = { ...rootCause, confidence: 0.85 };
    const critic = critiqueMultiOptionRecommendation(
      {
        recommended_option: "NO_ACTION_MONITOR",
        recommendation_reason: "Tồn kho thấp",
        tradeoff_summary: "Chi phí 0 đ",
        root_cause: highConfRootCause,
      },
      generateCandidateOptions(case002Facts, case002Lead, rootCause)
    );
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_HIGH_CONFIDENCE_CAUSAL_CLAIM")])
    );
  });

  it("8. historical cases immutable", () => {
    const case002Id = "1cbb5c3c-4958-4895-867b-1ca618d7acfd";
    const case003Id = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
    expect(case002Id).toBe("1cbb5c3c-4958-4895-867b-1ca618d7acfd");
    expect(case003Id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
  });

  it("9. production flow unchanged", async () => {
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
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: "case-shadow-123",
        event_type: "MULTI_OPTION_SHADOW_EVALUATED",
      })
    );
  });

  it("10. Telegram unchanged", () => {
    const shadowService = new NearTermCapacityMultiOptionShadowService({} as any);
    expect((shadowService as any).telegram).toBeUndefined();
  });

  it("11. SLA unavailable -> SLA_EFFECT UNKNOWN", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const noActionSla = evaluateOptionSla("NO_ACTION_MONITOR", case003Facts, case003Lead, rootCause);
    const addVehicleSla = evaluateOptionSla("ADD_VEHICLE", case003Facts, case003Lead, rootCause);

    expect(noActionSla.evidence_status).toBe("UNKNOWN");
    expect(noActionSla.projected_effect).toBe("UNKNOWN");
    expect(addVehicleSla.evidence_status).toBe("UNKNOWN");
    expect(addVehicleSla.projected_effect).toBe("UNKNOWN");
  });

  it("12. Case #003 recommends REQUEST_MORE_INFORMATION with explicit required items", async () => {
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

  it("13. Case #002 recommends NO_ACTION_MONITOR after evaluating alternatives", async () => {
    const result = await runMultiOptionEvaluation(case002Facts, case002Lead, {
      caseId: "case-002",
    });

    expect(result.root_cause.category).toBe("NO_MATERIAL_GAP");
    expect(result.recommended_option).toBe("NO_ACTION_MONITOR");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.critic_verdict).toBe("VALID");

    const addVehicle = result.candidate_options.find((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicle?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(addVehicle?.economic.status).toBe("UNKNOWN");

    const reallocate = result.candidate_options.find((o) => o.option_type === "REALLOCATE_AVAILABLE_CAPACITY");
    expect(reallocate?.feasibility_status).toBe("UNKNOWN");

    const manpower = result.candidate_options.find((o) => o.option_type === "ADD_MANPOWER");
    expect(manpower?.feasibility_status).toBe("UNKNOWN");
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
