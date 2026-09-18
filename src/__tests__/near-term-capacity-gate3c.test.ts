import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  GovernedVehicleSourceAdapter,
  evaluateOptionCost,
  evaluateOptionCapacity,
  evaluateOptionSla,
  computeProjectedCostDifference,
  generateCandidateOptions,
  evaluateRootCause,
  runMultiOptionEvaluation,
  critiqueMultiOptionRecommendation,
  type CurrentRisk,
  type LeadFact,
  type DecisionOption,
} from "@/domain/near-term-capacity";
import { NearTermCapacityMultiOptionShadowService } from "@/services/near-term-capacity-multi-option-shadow";

// Case #003 (Phú Thọ) snapshot: 87 orders, 11,697.69 kg
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
  suppliedBy: "telegram:lead-phutho",
  capturedAt: "2026-09-18T07:36:45.110Z",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  confidence: "LOW",
};

describe("OpsPilot Level C Gate 3C.1 — Governed Vehicle Economics + Capacity Source Integration", () => {
  it("1. missing rate -> cost UNKNOWN", () => {
    const adapter = new GovernedVehicleSourceAdapter();
    const rateEvidence = adapter.getVehicleRate("21160000", "STANDARD_EXTERNAL_TRUCK");

    expect(rateEvidence.evidence_status).toBe("UNKNOWN");
    expect(rateEvidence.rate_vnd).toBeNull();

    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
    expect(cost.evidence_status).toBe("UNKNOWN");
    expect(cost.incremental_cost_vnd).toBeNull();
  });

  it("2. missing vehicle class -> capacity UNKNOWN", () => {
    const adapter = new GovernedVehicleSourceAdapter();
    const capEvidence = adapter.getVehicleCapacity("NON_EXISTENT_CLASS");

    expect(capEvidence.evidence_status).toBe("UNKNOWN");
    expect(capEvidence.usable_payload_kg).toBeNull();

    const capacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, capEvidence);
    expect(capacity.status).toBe("UNKNOWN");
    expect(capacity.added_kg).toBeNull();
  });

  it("3. missing availability -> feasibility not FEASIBLE", () => {
    const adapter = new GovernedVehicleSourceAdapter();
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const vehicleEvidence = adapter.getVehicleEvidence("21160000");

    expect(vehicleEvidence.availability.evidence_status).toBe("UNKNOWN");
    expect(vehicleEvidence.availability.available).toBeNull();

    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause, vehicleEvidence);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    expect(addVehicle).toBeDefined();
    expect(addVehicle?.feasibility_status).not.toBe("FEASIBLE");
    expect(addVehicle?.feasible).toBe(false);
  });

  it("4. governed rate -> GOVERNED_RATE", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_5T",
          warehouse_or_scope: "21160000",
          rate_vnd: 1800000,
          rate_basis: "TRIP",
          source_ref: "GOV-MATRIX-2026-09",
          effective_at: new Date().toISOString(),
        },
      ],
    });

    const rateEvidence = adapter.getVehicleRate("21160000", "TRUCK_5T");
    expect(rateEvidence.evidence_status).toBe("GOVERNED_RATE");
    expect(rateEvidence.rate_vnd).toBe(1800000);
    expect(rateEvidence.rate_basis).toBe("TRIP");
    expect(rateEvidence.is_stale).toBe(false);

    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
    expect(cost.evidence_status).toBe("GOVERNED_RATE");
    expect(cost.incremental_cost_vnd).toBe(1800000);
  });

  it("5. stale rate rejected or marked stale", () => {
    const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_STALE",
          warehouse_or_scope: "21160000",
          rate_vnd: 1500000,
          rate_basis: "TRIP",
          source_ref: "EXPIRED-CONTRACT-2026",
          effective_at: staleDate,
          expires_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // expired 5 days ago
        },
      ],
      maxRateAgeDays: 30,
    });

    const rateEvidence = adapter.getVehicleRate("21160000", "TRUCK_STALE");
    expect(rateEvidence.is_stale).toBe(true);
    expect(rateEvidence.rate_vnd).toBeNull(); // Stale rate rejected from being used
    expect(rateEvidence.evidence_status).toBe("UNKNOWN");

    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
    expect(cost.evidence_status).toBe("UNKNOWN");
    expect(cost.incremental_cost_vnd).toBeNull();
    expect(cost.notes).toContain("hết hạn");
  });

  it("6. capacity never inferred from vehicle name alone unless mapped by governed source", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      capacities: {
        TRUCK_5T_GOVERNED: {
          max_payload_kg: 5000,
          usable_payload_kg: 4800,
          volume_m3: 20,
          source_ref: "SPEC-VEHICLE-CATALOG-2026",
          effective_at: new Date().toISOString(),
        },
      },
    });

    // An arbitrary name string saying "Xe tải 5 tấn" must NOT infer 5000 kg
    const unmappedEvidence = adapter.getVehicleCapacity("Xe tải 5 tấn");
    expect(unmappedEvidence.evidence_status).toBe("UNKNOWN");
    expect(unmappedEvidence.usable_payload_kg).toBeNull();

    // Governed mapped key successfully returns governed payload
    const mappedEvidence = adapter.getVehicleCapacity("TRUCK_5T_GOVERNED");
    expect(mappedEvidence.evidence_status).toBe("GOVERNED");
    expect(mappedEvidence.usable_payload_kg).toBe(4800);
  });

  it("7. unavailable vehicle cannot be selected", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      availabilities: [
        {
          warehouse_id: "21160000",
          vehicle_id: "29H-12345",
          vehicle_class: "TRUCK_5T",
          available: false, // Explicitly unavailable
          source_ref: "TELEMATICS-GPS-FLEET",
        },
      ],
    });

    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const vehicleEvidence = adapter.getVehicleEvidence("21160000", "TRUCK_5T");
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause, vehicleEvidence);

    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");
    expect(addVehicle).toBeDefined();
    expect(addVehicle?.feasibility_status).toBe("INFEASIBLE");
    expect(addVehicle?.feasible).toBe(false);
    expect(addVehicle?.feasibility_reason).toContain("Không có phương tiện vận tải khả dụng");

    // Critic strictly invalidates any recommendation of an INFEASIBLE option
    const critic = critiqueMultiOptionRecommendation(
      {
        recommended_option: "ADD_VEHICLE",
        recommendation_reason: "Cần điều xe",
        tradeoff_summary: "",
      },
      candidates
    );
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("SELECTED_OPTION_INFEASIBLE")])
    );
  });

  it("8. cost comparison cannot become realized saving", () => {
    const noActionCost = evaluateOptionCost("NO_ACTION_MONITOR", case003Facts, case003Lead);
    const addVehicleCost = {
      incremental_cost_vnd: 1500000,
      evidence_status: "GOVERNED_RATE" as const,
      source: "GOV_RATE",
    };

    const costDiff = computeProjectedCostDifference(addVehicleCost, noActionCost);
    expect(costDiff.difference_vnd).toBe(1500000);
    expect(costDiff.display).toBe("+1.500.000 đ");
    // Ensure display does NOT contain saving/roi
    expect(costDiff.display).not.toContain("saving");
    expect(costDiff.display).not.toContain("tiết kiệm");

    // Critic rejects any attempt to claim cost difference as realized saving or ROI
    const candidates = generateCandidateOptions(case003Facts, case003Lead, evaluateRootCause(case003Facts, case003Lead));
    const critic = critiqueMultiOptionRecommendation(
      {
        recommended_option: "NO_ACTION_MONITOR",
        recommendation_reason: "Giữ nguyên hiện trạng",
        tradeoff_summary: "Đạt mức tiết kiệm 1.500.000 đ chi phí", // False saving claim
      },
      candidates
    );
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_SAVING_CLAIM")])
    );
  });

  it("9. vehicle capacity improvement cannot imply SLA improvement", () => {
    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const governedCapacity = {
      vehicle_class: "TRUCK_5T",
      max_payload_kg: 5000,
      usable_payload_kg: 5000,
      volume_m3: 20,
      source_ref: "GOV-SPEC",
      effective_at: new Date().toISOString(),
      evidence_status: "GOVERNED" as const,
    };

    const addVehicleCapacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, governedCapacity);
    expect(addVehicleCapacity.added_kg).toBe(5000);
    expect(addVehicleCapacity.status).toBe("GOVERNED");

    // Even with 5,000 kg added, SLA effect MUST remain UNKNOWN
    const addVehicleSla = evaluateOptionSla("ADD_VEHICLE", case003Facts, case003Lead, rootCause);
    expect(addVehicleSla.projected_effect).toBe("UNKNOWN");
    expect(addVehicleSla.evidence_status).toBe("UNKNOWN");
  });

  it("10. production decision unchanged", async () => {
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
    const result = await shadowService.evaluateShadow("test-case-id", case003Facts, case003Lead);

    expect(result).not.toBeNull();
    // Authoritative production table must NEVER be mutated by shadow service
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: "test-case-id",
        event_type: "MULTI_OPTION_SHADOW_EVALUATED",
        actor: "shadow_engine:gate_3a",
      })
    );
  });

  it("11. Telegram unchanged", () => {
    const shadowService = new NearTermCapacityMultiOptionShadowService({} as any);
    expect((shadowService as any).telegram).toBeUndefined();
    expect((shadowService as any).bot).toBeUndefined();
  });

  it("12. historical Case #003 immutable", () => {
    const historicalCase003Id = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
    expect(historicalCase003Id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
    expect(case003Facts.warehouseId).toBe("21160000");
    expect(case003Facts.currentKg).toBe(11697.69);
    expect(case003Facts.currentOrders).toBe(87);
  });

  it("13. Case #004 production case untouched", () => {
    const liveCase004Id = "fdd16c22-ab97-44a5-b551-def3b7984d9b";
    expect(liveCase004Id).toBe("fdd16c22-ab97-44a5-b551-def3b7984d9b");
  });
});
