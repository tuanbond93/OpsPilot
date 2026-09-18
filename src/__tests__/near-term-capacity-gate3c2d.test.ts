import { describe, expect, it, vi } from "vitest";
import {
  GovernedVehicleSourceAdapter,
  evaluateOptionCost,
  evaluateOptionCapacity,
  generateCandidateOptions,
  evaluateRootCause,
  runMultiOptionEvaluation,
  critiqueMultiOptionRecommendation,
  formatCostDisplay,
  type CurrentRisk,
  type LeadFact,
} from "@/domain/near-term-capacity";
import {
  validateCandidateVehicleClass,
  validateCandidateVehicleRate,
  ALLOWED_RATE_BASES,
} from "@/domain/near-term-capacity/multi-option/sources/governed-source-validator";
import type { VehicleRateEvidence } from "@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter";
import { NearTermCapacityMultiOptionShadowService } from "@/services/near-term-capacity-multi-option-shadow";
import { NearTermCapacityDecisionBridge } from "@/services/near-term-capacity-decision-bridge";

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

// Lào Cai facts
const laoCaiFacts: CurrentRisk = {
  warehouseId: "21158000",
  warehouseName: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
  capturedAt: "2026-09-18T07:00:02.601Z",
  currentOrders: 65,
  currentKg: 8500,
  b2bOrders: null,
  evidenceRefs: ["incident:case-laocai"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Lao Cai backlog risk",
};

describe("OpsPilot Level C Gate 3C.2D — Owner-Confirmed Vehicle Master Data & Provisional Rate Evidence", () => {
  // Test 1: OWNER_CONFIRMED evidence supported
  it("1. OWNER_CONFIRMED evidence supported across rate, capacity, and cost", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const rateEvidence = adapter.getVehicleRate("21160000", "TRUCK_1_9T");
    expect(rateEvidence.evidence_status).toBe("OWNER_CONFIRMED");

    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
    expect(cost.evidence_status).toBe("OWNER_CONFIRMED");

    const capEvidence = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(capEvidence.evidence_status).toBe("OWNER_CONFIRMED");

    const capacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, capEvidence);
    expect(capacity.status).toBe("OWNER_CONFIRMED");
  });

  // Test 2: OWNER_CONFIRMED not mislabeled GOVERNED_RATE
  it("2. OWNER_CONFIRMED not mislabeled GOVERNED_RATE or GOVERNED", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const rate = adapter.getVehicleRate("21160000", "TRUCK_1_9T");
    expect(rate.evidence_status).toBe("OWNER_CONFIRMED");
    expect(rate.evidence_status).not.toBe("GOVERNED_RATE");

    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rate);
    expect(cost.evidence_status).toBe("OWNER_CONFIRMED");
    expect(cost.evidence_status).not.toBe("GOVERNED_RATE");

    const cap = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(cap.evidence_status).toBe("OWNER_CONFIRMED");
    expect(cap.evidence_status).not.toBe("GOVERNED");

    const optCap = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, cap);
    expect(optCap.status).toBe("OWNER_CONFIRMED");
    expect(optCap.status).not.toBe("GOVERNED");
  });

  // Test 3: pending-document rate allows NULL contract_ref
  it("3. pending-document rate allows NULL contract_ref", () => {
    const candidate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00+07:00",
      contract_ref: null, // Null contract_ref allowed
      source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
      supplier_name: "Thiên Phú",
      provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT" as const,
    };

    const result = validateCandidateVehicleRate(candidate, new Set(["TRUCK_1_9T"]));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sanitized?.contract_ref).toBeNull();
    expect(result.sanitized?.provenance_status).toBe("OWNER_CONFIRMED_PENDING_DOCUMENT");
  });

  // Test 4: DOCUMENT_VERIFIED requires contract_ref
  it("4. DOCUMENT_VERIFIED requires contract_ref", () => {
    const candidate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00+07:00",
      contract_ref: null, // Missing contract_ref on DOCUMENT_VERIFIED
      source_ref: "QD-BG-2026",
      supplier_name: "Thiên Phú",
      provenance_status: "DOCUMENT_VERIFIED" as const,
    };

    const result = validateCandidateVehicleRate(candidate, new Set(["TRUCK_1_9T"]));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("contract_ref is strictly required")])
    );
  });

  // Test 5: source_ref always required
  it("5. source_ref always required regardless of provenance_status", () => {
    const pendingRateNoSource = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00+07:00",
      contract_ref: null,
      source_ref: "   ", // Empty whitespace
      supplier_name: "Thiên Phú",
      provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT" as const,
    };

    const result1 = validateCandidateVehicleRate(pendingRateNoSource, new Set(["TRUCK_1_9T"]));
    expect(result1.valid).toBe(false);
    expect(result1.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("source_ref is strictly required")])
    );

    const pendingClassNoSource = {
      vehicle_class: "TRUCK_1_9T",
      max_payload_kg: 1900,
      effective_at: "2026-09-01T00:00:00+07:00",
      source_ref: "", // Empty source_ref
      provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT" as const,
    };

    const result2 = validateCandidateVehicleClass(pendingClassNoSource);
    expect(result2.valid).toBe(false);
    expect(result2.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("MISSING_PROVENANCE")])
    );
  });

  // Test 6: MONTH rate preserved exactly
  it("6. MONTH rate preserved exactly across all 5 owner rates", () => {
    const rates = [
      { supplier: "Thiên Phú", warehouse: "21160000", rate: 33551605 },
      { supplier: "Hoàng Minh", warehouse: "21160000", rate: 35663481 },
      { supplier: "Hoàng Minh", warehouse: "21158000", rate: 38041046 },
      { supplier: "Thuận Phát", warehouse: "21158000", rate: 36528734 },
      { supplier: "Hoàng Minh", warehouse: "21161000", rate: 36852263 },
    ];

    for (const r of rates) {
      const adapter = new GovernedVehicleSourceAdapter({
        rates: [
          {
            vehicle_class: "TRUCK_1_9T",
            warehouse_or_scope: r.warehouse,
            rate_vnd: r.rate,
            rate_basis: "MONTH",
            source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
            contract_ref: null,
            supplier_name: r.supplier,
            effective_at: "2026-09-01T00:00:00+07:00",
            provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
          },
        ],
      });

      const rateEvidence = adapter.getVehicleRate(r.warehouse, "TRUCK_1_9T");
      expect(rateEvidence.rate_vnd).toBe(r.rate);
      expect(rateEvidence.rate_basis).toBe("MONTH");

      const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
      expect(cost.incremental_cost_vnd).toBe(r.rate);
    }
  });

  // Test 7: 1900 max payload preserved
  it("7. 1900 max payload preserved from owner confirmation", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const cap = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(cap.max_payload_kg).toBe(1900);
  });

  // Test 8: 1600 usable payload preserved
  it("8. 1600 usable payload preserved as added capacity", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const cap = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(cap.usable_payload_kg).toBe(1600);

    const optCap = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, cap);
    expect(optCap.added_kg).toBe(1600);
  });

  // Test 9: 12 m3 preserved
  it("9. 12 m3 preserved from owner confirmation", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const cap = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(cap.volume_m3).toBe(12);
  });

  // Test 10: two Phú Thọ supplier scenarios preserved
  it("10. two Phú Thọ supplier scenarios preserved in candidates", async () => {
    const phuThoAdapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 35663481,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Hoàng Minh",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const rootCause = evaluateRootCause(case003Facts, case003Lead);
    const evidence = phuThoAdapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const candidates = generateCandidateOptions(case003Facts, case003Lead, rootCause, evidence);

    const addVehicles = candidates.filter((c) => c.option_type === "ADD_VEHICLE");
    expect(addVehicles).toHaveLength(2);

    const thienPhu = addVehicles.find((c) => c.option_id.includes("THIEN_PHU"));
    expect(thienPhu).toBeDefined();
    expect(thienPhu?.cost.incremental_cost_vnd).toBe(33551605);
    expect(thienPhu?.cost.evidence_status).toBe("OWNER_CONFIRMED");
    expect(thienPhu?.capacity.added_kg).toBe(1600);

    const hoangMinh = addVehicles.find((c) => c.option_id.includes("HOANG_MINH"));
    expect(hoangMinh).toBeDefined();
    expect(hoangMinh?.cost.incremental_cost_vnd).toBe(35663481);
    expect(hoangMinh?.cost.evidence_status).toBe("OWNER_CONFIRMED");
    expect(hoangMinh?.capacity.added_kg).toBe(1600);
  });

  // Test 11: two Lào Cai supplier scenarios preserved
  it("11. two Lào Cai supplier scenarios preserved in candidates", async () => {
    const laoCaiAdapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21158000",
          rate_vnd: 38041046,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Hoàng Minh",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21158000",
          rate_vnd: 36528734,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thuận Phát",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const rootCause = evaluateRootCause(laoCaiFacts, null);
    const evidence = laoCaiAdapter.getVehicleEvidence("21158000", "TRUCK_1_9T");
    const candidates = generateCandidateOptions(laoCaiFacts, null, rootCause, evidence);

    const addVehicles = candidates.filter((c) => c.option_type === "ADD_VEHICLE");
    expect(addVehicles).toHaveLength(2);

    const hoangMinh = addVehicles.find((c) => c.option_id.includes("HOANG_MINH"));
    expect(hoangMinh?.cost.incremental_cost_vnd).toBe(38041046);

    const thuanPhat = addVehicles.find((c) => c.option_id.includes("THUAN_PHAT"));
    expect(thuanPhat?.cost.incremental_cost_vnd).toBe(36528734);
  });

  // Test 12: monthly rates never divided by 30
  it("12. monthly rates never divided by 30", () => {
    const monthlyRate = 33551605;
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: monthlyRate,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
    });

    const rate = adapter.getVehicleRate("21160000", "TRUCK_1_9T");
    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rate);

    expect(cost.incremental_cost_vnd).not.toBe(Math.round(monthlyRate / 30));
    expect(cost.incremental_cost_vnd).toBe(monthlyRate);
  });

  // Test 13: cheapest supplier not auto-selected
  it("13. cheapest supplier not auto-selected", async () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605, // cheaper
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 35663481, // higher
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Hoàng Minh",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
    });

    const rates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    expect(rates).toHaveLength(2);
    expect(rates.map((r: VehicleRateEvidence) => r.rate_vnd)).toContain(35663481);

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    // Engine does NOT auto-select Thiên Phú or Hoàng Minh when availability is UNKNOWN!
    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.recommended_option).not.toBe("ADD_VEHICLE");
  });

  // Test 14: availability UNKNOWN prevents FEASIBLE
  it("14. availability UNKNOWN prevents FEASIBLE", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
      // availability is empty / missing
    });

    const evidence = adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const candidates = generateCandidateOptions(case003Facts, case003Lead, evaluateRootCause(case003Facts, case003Lead), evidence);

    const addVehicles = candidates.filter((c) => c.option_type === "ADD_VEHICLE");
    for (const opt of addVehicles) {
      expect(opt.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
      expect(opt.feasibility_status).not.toBe("FEASIBLE");
      expect(opt.feasible).toBe(false);
    }
  });

  // Test 15: no SLA improvement inferred
  it("15. no SLA improvement inferred", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
      capacities: {
        TRUCK_1_9T: {
          max_payload_kg: 1900,
          usable_payload_kg: 1600,
          volume_m3: 12,
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      },
    });

    const evidence = adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const candidates = generateCandidateOptions(case003Facts, case003Lead, evaluateRootCause(case003Facts, case003Lead), evidence);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    expect(addVehicle?.sla.projected_effect).toBe("UNKNOWN");
    expect(addVehicle?.sla.evidence_status).toBe("UNKNOWN");
  });

  // Test 16: no realized saving inferred
  it("16. no realized saving inferred", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
          contract_ref: null,
          supplier_name: "Thiên Phú",
          effective_at: "2026-09-01T00:00:00+07:00",
          provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
        },
      ],
    });

    const evidence = adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const candidates = generateCandidateOptions(case003Facts, case003Lead, evaluateRootCause(case003Facts, case003Lead), evidence);
    const addVehicle = candidates.find((c) => c.option_type === "ADD_VEHICLE");

    expect(addVehicle?.projected_cost_difference_display).not.toContain("saving");
    expect(addVehicle?.projected_cost_difference_display).not.toContain("tiết kiệm");

    const critic = critiqueMultiOptionRecommendation(
      {
        recommended_option: "NO_ACTION_MONITOR",
        recommendation_reason: "Duy trì",
        tradeoff_summary: "Đạt khoản tiết kiệm 33.551.605 đ so với xe ngoài",
      },
      candidates
    );
    expect(critic.verdict).toBe("INVALID");
    expect(critic.flags).toEqual(
      expect.arrayContaining([expect.stringContaining("UNSUPPORTED_SAVING_CLAIM")])
    );
  });

  // Test 17: production decision unchanged
  it("17. production decision unchanged", async () => {
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
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };

    const shadowService = new NearTermCapacityMultiOptionShadowService(mockDb);
    await shadowService.evaluateShadow("case-isolation-check", case003Facts, case003Lead);

    expect(updateMock).not.toHaveBeenCalled();
    expect(NearTermCapacityDecisionBridge).toBeDefined();
  });

  // Test 18: Telegram unchanged
  it("18. Telegram unchanged", () => {
    const shadowService = new NearTermCapacityMultiOptionShadowService({} as any);
    expect((shadowService as any).telegram).toBeUndefined();
    expect((shadowService as any).bot).toBeUndefined();
    expect((shadowService as any).sendMessage).toBeUndefined();
  });
});
