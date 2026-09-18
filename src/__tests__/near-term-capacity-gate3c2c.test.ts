import { describe, expect, it, vi } from "vitest";
import {
  GovernedVehicleSourceAdapter,
  evaluateOptionCost,
  evaluateOptionCapacity,
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

// Case #003 (Phú Thọ) snapshot
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

describe("OpsPilot Level C Gate 3C.2C — Monthly Rate + Multi-Supplier Schema Patch", () => {
  // Test 1: MONTH accepted
  it("1. MONTH accepted in validator and adapter", async () => {
    expect(ALLOWED_RATE_BASES).toContain("MONTH");

    const candidate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "HD-TP-2026/01",
      source_ref: "QD-OWNER-RATE",
      supplier_name: "Thiên Phú",
    };

    const validation = validateCandidateVehicleRate(candidate, new Set(["TRUCK_1_9T"]));
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
    expect(validation.sanitized?.rate_basis).toBe("MONTH");

    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "QD-OWNER-RATE",
          contract_ref: "HD-TP-2026/01",
          supplier_name: "Thiên Phú",
          effective_at: new Date().toISOString(),
        },
      ],
    });

    const rateEvidence = adapter.getVehicleRate("21160000", "TRUCK_1_9T");
    expect(rateEvidence.evidence_status).toBe("GOVERNED_RATE");
    expect(rateEvidence.rate_basis).toBe("MONTH");
    expect(rateEvidence.rate_vnd).toBe(33551605);
  });

  // Test 2: monthly price preserved exactly
  it("2. monthly price preserved exactly without alteration or rounding", () => {
    const ownerRates = [
      { supplier: "Thiên Phú", rate: 33551605, warehouse: "21160000" },
      { supplier: "Hoàng Minh", rate: 35663481, warehouse: "21160000" },
      { supplier: "Hoàng Minh", rate: 38041046, warehouse: "21158000" },
      { supplier: "Thuận Phát", rate: 36528734, warehouse: "21158000" },
      { supplier: "Hoàng Minh", rate: 36852263, warehouse: "21161000" },
    ];

    for (const item of ownerRates) {
      const adapter = new GovernedVehicleSourceAdapter({
        rates: [
          {
            vehicle_class: "TRUCK_1_9T",
            warehouse_or_scope: item.warehouse,
            rate_vnd: item.rate,
            rate_basis: "MONTH",
            source_ref: "QD-OWNER-RATE",
            contract_ref: `HD-${item.supplier}`,
            supplier_name: item.supplier,
            effective_at: new Date().toISOString(),
          },
        ],
      });

      const rateEvidence = adapter.getVehicleRate(item.warehouse, "TRUCK_1_9T");
      expect(rateEvidence.rate_vnd).toBe(item.rate);

      const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);
      expect(cost.incremental_cost_vnd).toBe(item.rate);
      expect(cost.value_vnd).toBe(item.rate);
      expect(formatCostDisplay(cost)).toContain(item.rate.toLocaleString("vi-VN"));
    }
  });

  // Test 3: no implicit /30 conversion
  it("3. no implicit /30 conversion (monthly price remains full contract rate)", () => {
    const thienPhuMonthlyRate = 33551605;
    const dailyRateIfDividedBy30 = thienPhuMonthlyRate / 30; // ~1,118,386.83

    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: thienPhuMonthlyRate,
          rate_basis: "MONTH",
          source_ref: "QD-OWNER-RATE",
          contract_ref: "HD-TP-01",
          supplier_name: "Thiên Phú",
          effective_at: new Date().toISOString(),
        },
      ],
    });

    const rateEvidence = adapter.getVehicleRate("21160000", "TRUCK_1_9T");
    const cost = evaluateOptionCost("ADD_VEHICLE", case003Facts, case003Lead, rateEvidence);

    // Invariant: MUST NOT divide by 30
    expect(cost.incremental_cost_vnd).not.toBe(Math.round(dailyRateIfDividedBy30));
    expect(cost.incremental_cost_vnd).not.toBe(dailyRateIfDividedBy30);
    expect(cost.incremental_cost_vnd).toBe(thienPhuMonthlyRate);
    expect(cost.notes).toContain("cơ sở tính: MONTH");
  });

  // Test 4: two suppliers at same warehouse/class can coexist
  it("4. two suppliers at same warehouse/class can coexist", () => {
    const thienPhuRate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "HD-TP-PHUTHO-2026",
      source_ref: "QD-BG-2026-09",
      supplier_name: "Thiên Phú",
    };

    const hoangMinhRate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 35663481,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "HD-HM-PHUTHO-2026",
      source_ref: "QD-BG-2026-09",
      supplier_name: "Hoàng Minh",
    };

    // First supplier validated against empty state
    const result1 = validateCandidateVehicleRate(thienPhuRate, new Set(["TRUCK_1_9T"]), []);
    expect(result1.valid).toBe(true);

    // Second supplier validated when first supplier is active
    const result2 = validateCandidateVehicleRate(hoangMinhRate, new Set(["TRUCK_1_9T"]), [thienPhuRate]);
    expect(result2.valid).toBe(true);
    expect(result2.errors).toHaveLength(0);

    // Both coexist in the adapter
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        { ...thienPhuRate, warehouse_or_scope: "21160000" },
        { ...hoangMinhRate, warehouse_or_scope: "21160000" },
      ],
    });

    const rates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    expect(rates).toHaveLength(2);
    expect(rates.map((r: VehicleRateEvidence) => r.supplier_name)).toEqual(expect.arrayContaining(["Thiên Phú", "Hoàng Minh"]));
  });

  // Test 5: exact duplicate governed rate rejected
  it("5. exact duplicate governed rate rejected", () => {
    const existingRate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "HD-TP-PHUTHO-2026",
      source_ref: "QD-BG-2026-09",
      supplier_name: "Thiên Phú",
    };

    const duplicateCandidate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-15T00:00:00Z",
      contract_ref: "HD-TP-PHUTHO-2026", // Identical supplier & contract
      source_ref: "QD-DUPLICATE",
      supplier_name: "Thiên Phú",
    };

    const result = validateCandidateVehicleRate(duplicateCandidate, new Set(["TRUCK_1_9T"]), [existingRate]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("CONFLICTING_ACTIVE_RATE")])
    );
  });

  // Test 6: supplier rates not averaged
  it("6. supplier rates not averaged", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605,
          rate_basis: "MONTH",
          source_ref: "QD-TP",
          contract_ref: "HD-TP",
          supplier_name: "Thiên Phú",
          effective_at: new Date().toISOString(),
        },
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 35663481,
          rate_basis: "MONTH",
          source_ref: "QD-HM",
          contract_ref: "HD-HM",
          supplier_name: "Hoàng Minh",
          effective_at: new Date().toISOString(),
        },
      ],
    });

    const rates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    const rateValues = rates.map((r: VehicleRateEvidence) => r.rate_vnd);
    const average = (33551605 + 35663481) / 2; // 34607543

    expect(rateValues).not.toContain(average);
    expect(rateValues).toContain(33551605);
    expect(rateValues).toContain(35663481);

    const thienPhu = adapter.getVehicleRate("21160000", "TRUCK_1_9T", "Thiên Phú");
    expect(thienPhu.rate_vnd).toBe(33551605);

    const hoangMinh = adapter.getVehicleRate("21160000", "TRUCK_1_9T", "Hoàng Minh");
    expect(hoangMinh.rate_vnd).toBe(35663481);
  });

  // Test 7: cheapest supplier not automatically selected
  it("7. cheapest supplier not automatically selected (both options preserved)", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: [
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 33551605, // cheaper
          rate_basis: "MONTH",
          source_ref: "QD-TP",
          contract_ref: "HD-TP",
          supplier_name: "Thiên Phú",
          effective_at: new Date().toISOString(),
        },
        {
          vehicle_class: "TRUCK_1_9T",
          warehouse_or_scope: "21160000",
          rate_vnd: 35663481, // higher
          rate_basis: "MONTH",
          source_ref: "QD-HM",
          contract_ref: "HD-HM",
          supplier_name: "Hoàng Minh",
          effective_at: new Date().toISOString(),
        },
      ],
    });

    const rates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    expect(rates).toHaveLength(2);

    // Ensure Hoàng Minh (higher price) is preserved and not dropped
    const hoangMinh = rates.find((r: VehicleRateEvidence) => r.supplier_name === "Hoàng Minh");
    expect(hoangMinh).toBeDefined();
    expect(hoangMinh?.rate_vnd).toBe(35663481);

    // Ensure specific querying of Hoàng Minh yields Hoàng Minh, not forced to cheapest
    const selectedHM = adapter.getVehicleRate("21160000", "TRUCK_1_9T", "Hoàng Minh");
    expect(selectedHM.supplier_name).toBe("Hoàng Minh");
    expect(selectedHM.rate_vnd).toBe(35663481);
  });

  // Test 8: missing contract_ref rejected
  it("8. missing contract_ref rejected", () => {
    const candidate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "   ", // Empty whitespace
      source_ref: "QD-BG-2026",
      supplier_name: "Thiên Phú",
    };

    const result = validateCandidateVehicleRate(candidate, new Set(["TRUCK_1_9T"]));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("contract_ref is strictly required")])
    );
  });

  // Test 9: missing source_ref rejected
  it("9. missing source_ref rejected", () => {
    const candidateRate = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      rate_vnd: 33551605,
      rate_basis: "MONTH" as const,
      effective_at: "2026-09-01T00:00:00Z",
      contract_ref: "HD-TP-01",
      source_ref: "", // Empty source_ref
      supplier_name: "Thiên Phú",
    };

    const rateResult = validateCandidateVehicleRate(candidateRate, new Set(["TRUCK_1_9T"]));
    expect(rateResult.valid).toBe(false);
    expect(rateResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("source_ref is strictly required")])
    );

    const candidateClass = {
      vehicle_class: "TRUCK_1_9T",
      max_payload_kg: 1900,
      effective_at: "2026-09-01T00:00:00Z",
      source_ref: "   ", // Empty source_ref
    };

    const classResult = validateCandidateVehicleClass(candidateClass);
    expect(classResult.valid).toBe(false);
    expect(classResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("MISSING_PROVENANCE")])
    );
  });

  // Test 10: missing vehicle payload prevents governed capacity claim
  it("10. missing vehicle payload prevents governed capacity claim (no inference from 1.9T label)", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      capacities: {}, // No confirmed payload spec for TRUCK_1_9T
    });

    const capEvidence = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(capEvidence.evidence_status).toBe("UNKNOWN");
    expect(capEvidence.usable_payload_kg).toBeNull();
    expect(capEvidence.max_payload_kg).toBeNull();

    // Invariant: Do NOT infer 1900 kg from "TRUCK_1_9T" label!
    const optionCapacity = evaluateOptionCapacity("ADD_VEHICLE", case003Facts, case003Lead, capEvidence);
    expect(optionCapacity.status).toBe("UNKNOWN");
    expect(optionCapacity.added_kg).toBeNull();
    expect(optionCapacity.added_kg).not.toBe(1900);
  });

  // Test 11: production decision unchanged
  it("11. production decision unchanged", async () => {
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

    // Production case records are never updated by shadow evaluation
    expect(updateMock).not.toHaveBeenCalled();
    expect(NearTermCapacityDecisionBridge).toBeDefined();
  });

  // Test 12: Telegram unchanged
  it("12. Telegram unchanged", () => {
    const shadowService = new NearTermCapacityMultiOptionShadowService({} as any);
    expect((shadowService as any).telegram).toBeUndefined();
    expect((shadowService as any).bot).toBeUndefined();
    expect((shadowService as any).sendMessage).toBeUndefined();
  });
});
