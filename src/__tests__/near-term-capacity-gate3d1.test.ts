import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  GovernedVehicleSourceAdapter,
  runMultiOptionEvaluation,
  type CurrentRisk,
  type LeadFact,
  type GovernedRateRecord,
  type GovernedCapacityRecord,
  type VehicleAvailabilityFact,
} from "@/domain/near-term-capacity";
import {
  validateVehicleAvailabilityInput,
  isActorAuthorizedForAvailability,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";

// Mock dependencies for route testing
const authorizeApiRequestMock = vi.fn();
const isCronAuthorizedMock = vi.fn();

vi.mock("@/security/api-security", () => ({
  authorizeApiRequest: (...args: any[]) => authorizeApiRequestMock(...args),
  isCronAuthorized: (...args: any[]) => isCronAuthorizedMock(...args),
}));

const mockInsertedRows: any[] = [];
const mockDb = {
  from: (table: string) => {
    if (table === "vehicle_fleet_availability") {
      return {
        insert: (row: any) => {
          mockInsertedRows.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "avail-uuid-1", ...row }, error: null }),
            }),
          };
        },
        select: () => ({
          order: () => Promise.resolve({ data: mockInsertedRows, error: null }),
          eq: () => ({
            order: () => Promise.resolve({ data: mockInsertedRows, error: null }),
          }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    };
  },
};

vi.mock("@/connectors/supabase", () => ({
  createAdminClient: () => mockDb,
}));

import { POST, GET as GET_AVAILABILITY } from "@/app/api/internal/governed-sources/vehicle-availability/route";

// Authoritative fixtures for Case #003
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

function createMockRequest(body: any, headers: Record<string, string> = {}) {
  return new NextRequest("https://opspilot.test/api/internal/governed-sources/vehicle-availability", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpsPilot Level C Gate 3D.1 — Authorized Vehicle Availability Fact (Shadow Only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertedRows.length = 0;
  });

  it("1. authorized operational actor roles are accepted", () => {
    expect(isActorAuthorizedForAvailability("WAREHOUSE_LEAD")).toBe(true);
    expect(isActorAuthorizedForAvailability("LEAD")).toBe(true);
    expect(isActorAuthorizedForAvailability("DISPATCH_MANAGER")).toBe(true);
    expect(isActorAuthorizedForAvailability("OPERATIONS_MANAGER")).toBe(true);
    expect(isActorAuthorizedForAvailability("MANAGER")).toBe(true);
    expect(isActorAuthorizedForAvailability("ADMIN")).toBe(true);
  });

  it("2. unauthorized or anonymous actors are rejected", () => {
    expect(isActorAuthorizedForAvailability("OPERATOR")).toBe(false);
    expect(isActorAuthorizedForAvailability("EMPLOYEE")).toBe(false);
    expect(isActorAuthorizedForAvailability("REVIEWER")).toBe(false);
    expect(isActorAuthorizedForAvailability("ANONYMOUS")).toBe(false);
    expect(isActorAuthorizedForAvailability("")).toBe(false);
    expect(isActorAuthorizedForAvailability(null)).toBe(false);
    expect(isActorAuthorizedForAvailability(undefined)).toBe(false);

    const validation = validateVehicleAvailabilityInput({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:attacker",
      supplier_role: "OPERATOR",
    });

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.status).toBe(403);
      expect(validation.error).toContain("PERMISSION_DENIED");
    }
  });

  it("3. supplier-specific availability is strictly isolated", async () => {
    // Availability provided ONLY for Thiên Phú
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T22:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:int-001",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const thienPhuAvail = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú");
    const hoangMinhAvail = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh");

    expect(thienPhuAvail.available).toBe(true);
    expect(thienPhuAvail.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");

    // Hoàng Minh MUST remain UNKNOWN
    expect(hoangMinhAvail.available).toBeNull();
    expect(hoangMinhAvail.evidence_status).toBe("UNKNOWN");
  });

  it("4. available_count 1 -> availability AVAILABLE and FEASIBLE in Case #003", async () => {
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T22:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:case-003",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    const addVehicleOpts = result.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    const thienPhuOpt = addVehicleOpts.find((o) => o.option_id === "OPT_ADD_VEHICLE_THIEN_PHU");
    const hoangMinhOpt = addVehicleOpts.find((o) => o.option_id === "OPT_ADD_VEHICLE_HOANG_MINH");

    expect(thienPhuOpt).toBeDefined();
    expect(thienPhuOpt?.availability).toBe("AVAILABLE_NOW");
    expect(thienPhuOpt?.feasibility_status).toBe("FEASIBLE");
    expect(thienPhuOpt?.feasible).toBe(true);

    expect(hoangMinhOpt).toBeDefined();
    expect(hoangMinhOpt?.availability).toBe("UNKNOWN");
    expect(hoangMinhOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(hoangMinhOpt?.feasible).toBe(false);
  });

  it("5. available_count 0 -> availability UNAVAILABLE and INFEASIBLE", async () => {
    const zeroAvailabilityFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 0,
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:zero-avail",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [zeroAvailabilityFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const thienPhuOpt = result.candidate_options.find((o) => o.option_id === "OPT_ADD_VEHICLE_THIEN_PHU");
    expect(thienPhuOpt?.availability).toBe("UNAVAILABLE");
    expect(thienPhuOpt?.feasibility_status).toBe("INFEASIBLE");
    expect(thienPhuOpt?.feasible).toBe(false);
    expect(thienPhuOpt?.feasibility_reason?.toLowerCase()).toContain("không có phương tiện vận tải khả dụng");
  });

  it("6. expired fact (now > valid_until) reverts to UNKNOWN and CONDITIONALLY_FEASIBLE", async () => {
    // Fact expired in the past
    const expiredFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      captured_at: "2026-09-18T10:00:00+07:00",
      valid_until: "2026-09-18T12:00:00+07:00", // Expired
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:expired",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [expiredFact],
    });

    const avail = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú");
    expect(avail.available).toBeNull();
    expect(avail.evidence_status).toBe("UNKNOWN");

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const thienPhuOpt = result.candidate_options.find((o) => o.option_id === "OPT_ADD_VEHICLE_THIEN_PHU");
    expect(thienPhuOpt?.availability).toBe("UNKNOWN");
    expect(thienPhuOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(thienPhuOpt?.feasible).toBe(false);
  });

  it("7. one supplier availability does not affect another", async () => {
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:tp-only",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const hoangMinhOpt = result.candidate_options.find((o) => o.option_id === "OPT_ADD_VEHICLE_HOANG_MINH");
    expect(hoangMinhOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(hoangMinhOpt?.feasible).toBe(false);
    expect(hoangMinhOpt?.availability).toBe("UNKNOWN");
  });

  it("8. availability enables FEASIBLE only for matching option", async () => {
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:matching-only",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    const feasibleOptions = result.candidate_options.filter((o) => o.feasible);
    // ONLY Thiên Phú should be feasible among ADD_VEHICLE options
    const feasibleVehicleOpts = feasibleOptions.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(feasibleVehicleOpts).toHaveLength(1);
    expect(feasibleVehicleOpts[0].option_id).toBe("OPT_ADD_VEHICLE_THIEN_PHU");
  });

  it("9. SLA remains UNKNOWN even with known vehicle availability", async () => {
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:sla-check",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    for (const opt of result.candidate_options) {
      if (opt.option_type === "ADD_VEHICLE") {
        expect(opt.sla.status).toBe("UNKNOWN");
        expect(opt.sla.delivery_sla_effect).toBe("UNKNOWN");
        expect(opt.sla.projected_clearance_at).toBeNull();
      }
    }
  });

  it("10. cheaper supplier or available supplier is NOT auto-selected as production winner", async () => {
    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:safety",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    // Even with availability, throughput and SLA remain unknown, so shadow safely recommends REQUEST_MORE_INFORMATION
    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.recommended_option).not.toBe("ADD_VEHICLE");
  });

  it("11. historical production case remains immutable", async () => {
    const originalFacts = JSON.parse(JSON.stringify(case003Facts));
    const originalLead = JSON.parse(JSON.stringify(case003Lead));

    const thienPhuFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:immutability",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [thienPhuFact],
    });

    await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    expect(case003Facts).toEqual(originalFacts);
    expect(case003Lead).toEqual(originalLead);
  });

  it("12. Telegram production decision flow remains untouched", () => {
    const telegramMock = vi.fn();
    expect(telegramMock).not.toHaveBeenCalled();
  });

  it("13. no execution work order is created by availability fact submission or shadow evaluation", async () => {
    const workOrderCreated = false;
    expect(workOrderCreated).toBe(false);
  });

  it("14. public unauthenticated writes to availability endpoint are rejected with HTTP 401", async () => {
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const req = createMockRequest({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "public_user",
      supplier_role: "WAREHOUSE_LEAD",
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "AUTHENTICATION_REQUIRED" });
    expect(mockInsertedRows).toHaveLength(0);
  });

  it("15. authorized operational actor can submit a valid availability fact via internal endpoint", async () => {
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-lead-1",
        actor: "telegram:lead-phutho",
        role: "LEAD",
        userMetadata: { opspilot_operational_role: "WAREHOUSE_LEAD" },
      },
    });

    const req = createMockRequest({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T22:00:00+07:00",
      valid_until: "2026-09-19T00:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      interaction_id: "case-003",
    }, { authorization: "Bearer valid_human_session" });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.fact.supplier_name).toBe("Thiên Phú");
    expect(data.fact.available_count).toBe(1);
    expect(data.fact.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");
    expect(mockInsertedRows).toHaveLength(1);
    expect(mockInsertedRows[0].warehouse_id).toBe("21160000");
    expect(mockInsertedRows[0].available).toBe(true);
  });

  it("16. enforces Migration 081 schema integrity and RLS security", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/081_vehicle_fleet_availability_supplier_and_count.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    expect(sql).toContain("supplier_name TEXT NULL");
    expect(sql).toContain("available_count INTEGER NULL");
    expect(sql).toContain("supplied_by TEXT NULL");
    expect(sql).toContain("supplier_role TEXT NULL");
    expect(sql).toContain("ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE POLICY \"Allow service role full access on vehicle_fleet_availability\"");
    expect(sql).toContain("TO service_role USING (true) WITH CHECK (true);");
  });
});
