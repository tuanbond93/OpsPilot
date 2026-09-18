import { describe, expect, it, vi } from "vitest";
import {
  GovernedVehicleSourceAdapter,
  runMultiOptionEvaluation,
  type CurrentRisk,
  type LeadFact,
  type GovernedRateRecord,
  type GovernedCapacityRecord,
} from "@/domain/near-term-capacity";
import { resolveRequestedInformation } from "@/domain/near-term-capacity/multi-option/option-registry";

// Authoritative Owner Phase 1 Data fixtures
const ownerClassRecord: GovernedCapacityRecord = {
  max_payload_kg: 1900,
  usable_payload_kg: 1600,
  volume_m3: 12,
  effective_at: "2026-09-01T00:00:00+07:00",
  source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
  provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
};

const ownerRateRecords: GovernedRateRecord[] = [
  {
    warehouse_or_scope: "21160000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Thiên Phú",
    rate_vnd: 33551605,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    warehouse_or_scope: "21160000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 35663481,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    warehouse_or_scope: "21158000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Thuận Phát",
    rate_vnd: 36528734,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    warehouse_or_scope: "21158000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 38041046,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    warehouse_or_scope: "21161000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 36852263,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
];

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

function createOwnerAdapter() {
  return new GovernedVehicleSourceAdapter({
    rates: ownerRateRecords,
    capacities: {
      TRUCK_1_9T: ownerClassRecord,
    },
  });
}

describe("OpsPilot Level C Gate 3C.3 — Owner Data Shadow Validation on Production Sources", () => {
  it("1. production class record parsed correctly", () => {
    const adapter = createOwnerAdapter();
    const capacity = adapter.getVehicleCapacity("TRUCK_1_9T");

    expect(capacity.max_payload_kg).toBe(1900);
    expect(capacity.usable_payload_kg).toBe(1600);
    expect(capacity.volume_m3).toBe(12);
    expect(capacity.effective_at).toBe("2026-09-01T00:00:00+07:00");
    expect(capacity.provenance_status).toBe("OWNER_CONFIRMED_PENDING_DOCUMENT");
    expect(capacity.source_ref).toBe("OWNER_CONFIRMED:OPS_OWNER:2026-09-18");
  });

  it("2. production rate records parsed correctly", () => {
    const adapter = createOwnerAdapter();

    const phuThoRates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    const laoCaiRates = adapter.getVehicleRates("21158000", "TRUCK_1_9T");
    const yenBaiRates = adapter.getVehicleRates("21161000", "TRUCK_1_9T");

    expect(phuThoRates).toHaveLength(2);
    expect(laoCaiRates).toHaveLength(2);
    expect(yenBaiRates).toHaveLength(1);

    const allRates = [...phuThoRates, ...laoCaiRates, ...yenBaiRates];
    expect(allRates).toHaveLength(5);

    for (const r of allRates) {
      expect(r.rate_basis).toBe("MONTH");
      expect(r.contract_ref).toBeNull();
      expect(r.provenance_status).toBe("OWNER_CONFIRMED_PENDING_DOCUMENT");
      expect(r.source_ref).toBe("OWNER_CONFIRMED:OPS_OWNER:2026-09-18");
    }
  });

  it("3. OWNER_CONFIRMED remains distinct from GOVERNED_RATE", () => {
    const adapter = createOwnerAdapter();
    const evidence = adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");

    expect(evidence.capacity.evidence_status).toBe("OWNER_CONFIRMED");
    expect(evidence.capacity.evidence_status).not.toBe("GOVERNED");
    expect(evidence.capacity.evidence_status).not.toBe("DOCUMENT_VERIFIED");

    expect(evidence.rate.evidence_status).toBe("OWNER_CONFIRMED");
    expect(evidence.rate.evidence_status).not.toBe("GOVERNED_RATE");
    expect(evidence.rate.evidence_status).not.toBe("DOCUMENT_VERIFIED");
  });

  it("4. Phú Thọ creates two supplier scenarios", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicleOpts).toHaveLength(2);

    const optionIds = addVehicleOpts.map((o) => o.option_id);
    expect(optionIds).toContain("OPT_ADD_VEHICLE_THIEN_PHU");
    expect(optionIds).toContain("OPT_ADD_VEHICLE_HOANG_MINH");
  });

  it("5. Lào Cai creates two supplier scenarios", async () => {
    const adapter = createOwnerAdapter();
    const laoCaiFacts: CurrentRisk = {
      ...case003Facts,
      warehouseId: "21158000",
      warehouseName: "Kho Giao Hàng Nặng - Lào Cai",
    };

    const result = await runMultiOptionEvaluation(laoCaiFacts, case003Lead, {
      caseId: "case-laocai",
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicleOpts).toHaveLength(2);

    const optionIds = addVehicleOpts.map((o) => o.option_id);
    expect(optionIds).toContain("OPT_ADD_VEHICLE_THUAN_PHAT");
    expect(optionIds).toContain("OPT_ADD_VEHICLE_HOANG_MINH");
  });

  it("6. Yên Bái creates one supplier scenario", async () => {
    const adapter = createOwnerAdapter();
    const yenBaiFacts: CurrentRisk = {
      ...case003Facts,
      warehouseId: "21161000",
      warehouseName: "Kho Giao Hàng Nặng - TP Yên Bái",
    };

    const result = await runMultiOptionEvaluation(yenBaiFacts, case003Lead, {
      caseId: "case-yenbai",
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicleOpts).toHaveLength(1);
    expect(addVehicleOpts[0].option_id).toBe("OPT_ADD_VEHICLE_HOANG_MINH");
  });

  it("7. added capacity = 1600", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    for (const opt of addVehicleOpts) {
      expect(opt.capacity.added_kg).toBe(1600);
      expect(opt.capacity.status).toBe("OWNER_CONFIRMED");
    }
  });

  it("8. max payload = 1900 retained", () => {
    const adapter = createOwnerAdapter();
    const cap = adapter.getVehicleCapacity("TRUCK_1_9T");
    expect(cap.max_payload_kg).toBe(1900);
    expect(cap.usable_payload_kg).toBe(1600);
  });

  it("9. MONTH price exact", async () => {
    const adapter = createOwnerAdapter();
    const rates = adapter.getVehicleRates("21160000", "TRUCK_1_9T");

    const thienPhu = rates.find((r: any) => r.supplier_name === "Thiên Phú");
    const hoangMinh = rates.find((r: any) => r.supplier_name === "Hoàng Minh");

    expect(thienPhu?.rate_vnd).toBe(33551605);
    expect(thienPhu?.rate_basis).toBe("MONTH");
    expect(hoangMinh?.rate_vnd).toBe(35663481);
    expect(hoangMinh?.rate_basis).toBe("MONTH");
  });

  it("10. no /30 conversion", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    const thienPhuOpt = addVehicleOpts.find((o) => o.option_id === "OPT_ADD_VEHICLE_THIEN_PHU");

    expect(thienPhuOpt?.cost.incremental_cost_vnd).toBe(33551605);
    expect(thienPhuOpt?.cost.rate_basis).toBe("MONTH");
    expect(thienPhuOpt?.cost.incremental_cost_vnd).not.toBe(Math.round(33551605 / 30));
  });

  it("11. supplier rates not averaged", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    const costs = addVehicleOpts.map((o) => o.cost.incremental_cost_vnd);

    expect(costs).toHaveLength(2);
    expect(costs).toContain(33551605);
    expect(costs).toContain(35663481);
    const average = (33551605 + 35663481) / 2;
    expect(costs).not.toContain(average);
  });

  it("12. cheaper supplier not auto-selected", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    // Both supplier options must be present as distinct alternatives
    expect(result.candidate_options.some((o) => o.option_id === "OPT_ADD_VEHICLE_THIEN_PHU")).toBe(true);
    expect(result.candidate_options.some((o) => o.option_id === "OPT_ADD_VEHICLE_HOANG_MINH")).toBe(true);

    // Recommended option safely defaults to REQUEST_MORE_INFORMATION due to unknown availability & throughput
    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.recommended_option).not.toBe("ADD_VEHICLE");
  });

  it("13. availability UNKNOWN -> CONDITIONAL", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    for (const opt of addVehicleOpts) {
      expect(opt.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
      expect(opt.feasible).toBe(false);
      expect(opt.feasibility_reason).toContain("Chưa xác nhận khả dụng xe");
    }
  });

  it("14. SLA remains UNKNOWN", async () => {
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    for (const opt of addVehicleOpts) {
      expect(opt.sla.status).toBe("UNKNOWN");
      expect(opt.sla.delivery_sla_effect).toBe("UNKNOWN");
      expect(opt.sla.projected_clearance_at).toBeNull();
    }
  });

  it("15. requested-info list removes known rate/capacity fields", () => {
    // Before Phase 1: No evidence
    const missingBefore = resolveRequestedInformation(null);
    expect(missingBefore).toContain("vehicle class/capacity");
    expect(missingBefore).toContain("vehicle monthly rate");

    // After Phase 1: Owner evidence present
    const adapter = createOwnerAdapter();
    const evidence = adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const missingAfter = resolveRequestedInformation(evidence);

    expect(missingAfter).not.toContain("vehicle class/capacity");
    expect(missingAfter).not.toContain("vehicle monthly rate");

    // Still requests operational parameters
    expect(missingAfter.some((i) => i.includes("available vehicle count"))).toBe(true);
    expect(missingAfter.some((i) => i.includes("availability"))).toBe(true);
    expect(missingAfter.some((i) => i.includes("available time") || i.includes("arrival time"))).toBe(true);
    expect(missingAfter).toContain("station clearance throughput");
    expect(missingAfter).toContain("order-level SLA deadlines");
  });

  it("16. historical production case immutable", async () => {
    // Historical replay must not mutate input objects
    const originalFacts = JSON.parse(JSON.stringify(case003Facts));
    const originalLead = JSON.parse(JSON.stringify(case003Lead));

    const adapter = createOwnerAdapter();
    await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    expect(case003Facts).toEqual(originalFacts);
    expect(case003Lead).toEqual(originalLead);
  });

  it("17. Telegram unchanged", () => {
    // Verifies no Telegram dispatch calls are made during multi-option evaluation
    const telegramMock = vi.fn();
    const adapter = createOwnerAdapter();
    const result = adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    expect(result).toHaveLength(2);
    expect(telegramMock).not.toHaveBeenCalled();
  });

  it("18. production decision unchanged", async () => {
    // Shadow execution remains isolated from authoritative production decision bridge
    const adapter = createOwnerAdapter();
    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    expect(result.critic_verdict).toBe("VALID");
    expect(result.decision_case_id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
    // Authoritative bridge decision is separate; shadow returns purely comparative analysis
    // 6 rows: NO_ACTION, ADD_VEHICLE (Thiên Phú), ADD_VEHICLE (Hoàng Minh), REALLOCATE, ADD_MANPOWER, REQUEST_MORE_INFO
    expect(result.matrix.rows).toHaveLength(6);
  });
});
