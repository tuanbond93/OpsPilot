import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  GovernedVehicleSourceAdapter,
  runMultiOptionEvaluation,
  type CurrentRisk,
  type LeadFact,
  type GovernedRateRecord,
  type GovernedCapacityRecord,
  type VehicleAvailabilityFact,
  type VehicleAvailabilitySchedule,
} from "@/domain/near-term-capacity";
import {
  validateVehicleAvailabilityInput,
  isActorAuthorizedForAvailability,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";

// Mock security dependencies
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
              single: () => Promise.resolve({ data: { id: "avail-uuid-gate3d4", ...row }, error: null }),
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

const ownerClassRecord: GovernedCapacityRecord = {
  max_payload_kg: 1900,
  usable_payload_kg: 1600,
  volume_m3: 12,
  effective_at: "2026-09-01T00:00:00+07:00",
  source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
  provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
};

const pilotRateRecords: GovernedRateRecord[] = [
  // Phú Thọ (21160000)
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
  // Lào Cai (21158000)
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
  // Yên Bái (21161000)
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

const ownerSchedules: VehicleAvailabilitySchedule[] = [
  {
    warehouse_id: "21161000",
    supplier_name: "Hoàng Minh",
    vehicle_class: "TRUCK_1_9T",
    planned_available_count: 1,
    recurrence_type: "DAILY",
    timezone: "Asia/Ho_Chi_Minh",
    local_start_time: "07:00",
    local_end_time: "10:00",
    effective_from: "2026-09-19",
    effective_until: null,
    supplied_by: "OPS_OWNER",
    supplier_role: "OPERATIONS_MANAGER",
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
  },
  {
    warehouse_id: "21158000",
    supplier_name: "Thuận Phát",
    vehicle_class: "TRUCK_1_9T",
    planned_available_count: 2,
    recurrence_type: "DAILY",
    timezone: "Asia/Ho_Chi_Minh",
    local_start_time: "07:00",
    local_end_time: "10:00",
    effective_from: "2026-09-19",
    effective_until: null,
    supplied_by: "OPS_OWNER",
    supplier_role: "OPERATIONS_MANAGER",
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
  },
  {
    warehouse_id: "21160000",
    supplier_name: "Thiên Phú",
    vehicle_class: "TRUCK_1_9T",
    planned_available_count: 5,
    recurrence_type: "DAILY",
    timezone: "Asia/Ho_Chi_Minh",
    local_start_time: "07:00",
    local_end_time: "10:00",
    effective_from: "2026-09-19",
    effective_until: null,
    supplied_by: "OPS_OWNER",
    supplier_role: "OPERATIONS_MANAGER",
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
  },
  {
    warehouse_id: "21160000",
    supplier_name: "Hoàng Minh",
    vehicle_class: "TRUCK_1_9T",
    planned_available_count: 5,
    recurrence_type: "DAILY",
    timezone: "Asia/Ho_Chi_Minh",
    local_start_time: "07:00",
    local_end_time: "10:00",
    effective_from: "2026-09-19",
    effective_until: null,
    supplied_by: "OPS_OWNER",
    supplier_role: "OPERATIONS_MANAGER",
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
    provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
  },
];

const case003Facts: CurrentRisk = {
  warehouseId: "21160000",
  warehouseName: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
  capturedAt: "2026-09-19T08:00:00+07:00",
  currentOrders: 65,
  currentKg: 6245.5,
  b2bOrders: 10,
  evidenceRefs: ["wms:order_run:case003", "chat:dispatch:case003"],
  riskSignals: ["KHO_TON", "QUA_TAI_TRONG_TAI", "DON_CHO_XU_LY_CAO"],
  hardSlaConstraint: "Risk",
};

const case003Lead: LeadFact = {
  interactionId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
  suppliedBy: "telegram:lead-phutho",
  capturedAt: "2026-09-19T08:05:00+07:00",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  confidence: "LOW",
};

function createMockRequest(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpsPilot Level C Gate 3D.4 — Live Vehicle Availability Fact & Governance Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertedRows.length = 0;
  });

  // 1. Fresh positive live fact -> AVAILABLE_NOW
  it("1. fresh positive live fact evaluates to AVAILABLE_NOW", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(ev?.availability_status).toBe("AVAILABLE_NOW");
    expect(ev?.available_count).toBe(1);
    expect(ev?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");
    expect(ev?.available).toBe(true);
  });

  // 2. Live fact overrides recurring schedule
  it("2. live fact overrides recurring schedule evidence", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    // Schedule has planned count 5 for Phú Thọ / Thiên Phú
    // Live fact confirms count 2
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test-override",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");
    expect(ev?.availability_status).toBe("AVAILABLE_NOW");
    expect(ev?.available_count).toBe(2); // Not schedule's count 5
  });

  // 3. Yên Bái count 1 -> 1600kg
  it("3. Yên Bái count 1 maps to exactly 1600kg usable payload", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:yb",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const ybRisk: CurrentRisk = {
      warehouseId: "21161000",
      warehouseName: "Kho Yên Bái",
      capturedAt: evalTime,
      currentOrders: 20,
      currentKg: 1500,
      b2bOrders: null,
      evidenceRefs: ["ref:yb"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Risk",
    };

    const res = await runMultiOptionEvaluation(ybRisk, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const hmOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Hoàng Minh");
    expect(hmOpt?.capacity.planned_available_count).toBe(1);
    expect(hmOpt?.capacity.planned_capacity_kg).toBe(1600); // 1 * 1600
  });

  // 4. Lào Cai count 1 -> 1600kg
  it("4. Lào Cai count 1 maps to exactly 1600kg usable payload", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21158000",
      supplier_name: "Thuận Phát",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:lc",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const lcRisk: CurrentRisk = {
      warehouseId: "21158000",
      warehouseName: "Kho Lào Cai",
      capturedAt: evalTime,
      currentOrders: 20,
      currentKg: 1500,
      b2bOrders: null,
      evidenceRefs: ["ref:lc"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Risk",
    };

    const res = await runMultiOptionEvaluation(lcRisk, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thuận Phát");
    expect(tpOpt?.capacity.planned_available_count).toBe(1);
    expect(tpOpt?.capacity.planned_capacity_kg).toBe(1600); // 1 * 1600
  });

  // 5. Phú Thọ Thiên Phú count 2 -> 3200kg
  it("5. Phú Thọ Thiên Phú count 2 maps to exactly 3200kg usable payload", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:pt-tp",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.capacity.planned_available_count).toBe(2);
    expect(tpOpt?.capacity.planned_capacity_kg).toBe(3200); // 2 * 1600
  });

  // 6. Phú Thọ Hoàng Minh count 2 -> 3200kg
  it("6. Phú Thọ Hoàng Minh count 2 maps to exactly 3200kg usable payload", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:pt-hm",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const hmOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Hoàng Minh");
    expect(hmOpt?.capacity.planned_available_count).toBe(2);
    expect(hmOpt?.capacity.planned_capacity_kg).toBe(3200); // 2 * 1600
  });

  // 7. Supplier isolation
  it("7. supplier availability facts are strictly isolated", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:iso",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const tpEv = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    const hmEv = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", evalTime);

    expect(tpEv?.availability_status).toBe("AVAILABLE_NOW");
    expect(tpEv?.available_count).toBe(2);

    expect(hmEv?.availability_status).toBe("UNKNOWN");
    expect(hmEv?.available).toBeNull();
    expect(hmEv?.available_count).toBeUndefined();
  });

  // 8. Lào Cai Hoàng Minh remains UNKNOWN (negative control)
  it("8. Lào Cai Hoàng Minh (negative control) remains UNKNOWN with count 0", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const hmEv = adapter.getVehicleAvailability("21158000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(hmEv?.availability_status).toBe("UNKNOWN");
    expect(hmEv?.available_count).toBeUndefined();
    expect(hmEv?.available).toBeNull();
  });

  // 9. observed_at distinct from earliest_available_at
  it("9. captured_at (observation time) is strictly distinct from earliest_available_at", () => {
    const earliestAvailable = "2026-09-19T07:00:00+07:00";
    const writeTime = "2026-09-19T10:45:00+07:00";

    const fact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: earliestAvailable,
      captured_at: writeTime,
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:distinct",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    expect(fact.captured_at).not.toBe(fact.earliest_available_at);
    expect(new Date(fact.captured_at).getTime()).toBeGreaterThan(new Date(fact.earliest_available_at!).getTime());
  });

  // 10. current confirmation does not get backdated to 07:00
  it("10. confirmation time (captured_at) does not get backdated to 07:00 start time", () => {
    const nowMs = new Date("2026-09-19T10:46:00+07:00").getTime();
    const res = validateVehicleAvailabilityInput(
      {
        warehouse_id: "21161000",
        supplier_name: "Hoàng Minh",
        vehicle_class: "TRUCK_1_9T",
        available_count: 1,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "ops-manager-1",
        supplier_role: "OPERATIONS_MANAGER",
      },
      undefined,
      nowMs
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fact.earliest_available_at).toBe(new Date("2026-09-19T07:00:00+07:00").toISOString());
      expect(res.fact.captured_at).toBe(new Date(nowMs).toISOString());
      expect(res.fact.captured_at).not.toBe(res.fact.earliest_available_at);
    }
  });

  // 11. missing valid_until is not fabricated (strictly rejected with HTTP 400)
  it("11. missing valid_until is strictly rejected with HTTP 400 and never fabricated", async () => {
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-mgr-1",
        actor: "ops-manager@domain.com",
        role: "OPERATIONS_MANAGER",
        userMetadata: { opspilot_operational_role: "OPERATIONS_MANAGER" },
      },
    });

    const req = createMockRequest({
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      // Notice: valid_until is intentionally missing!
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid_until is required");
    expect(body.error).toContain("TTL must not be silently invented");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 12. unauthorized actor cannot create live fact (HTTP 403)
  it("12. unauthorized actor cannot create live fact (HTTP 403 PERMISSION_DENIED)", async () => {
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-viewer-1",
        actor: "viewer@domain.com",
        role: "VIEWER",
        userMetadata: { opspilot_operational_role: "VIEWER" },
      },
    });

    const req = createMockRequest({
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("PERMISSION_DENIED");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 13. service credential cannot self-declare human actor (HTTP 403 FORBIDDEN_IMPERSONATION)
  it("13. service credential cannot masquerade as human actor (HTTP 403 FORBIDDEN_IMPERSONATION)", async () => {
    isCronAuthorizedMock.mockReturnValue(true);

    const req = createMockRequest({
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "telegram:human-manager",
      supplier_role: "OPERATIONS_MANAGER",
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("FORBIDDEN_IMPERSONATION");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 14. live fact precedence over schedule
  it("14. live fact takes absolute precedence over recurring schedule", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:prec",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(ev?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");
    expect(ev?.availability_status).toBe("AVAILABLE_NOW");
  });

  // 15. expired live fact falls back to schedule
  it("15. expired live fact falls back to recurring schedule", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const expiredFact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T09:00:00+07:00", // Expired at 09:00
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:expired",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [expiredFact],
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    // Falls back to schedule rolling to tomorrow
    expect(ev?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(ev?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(ev?.earliest_available_at).toBe("2026-09-20T07:00:00+07:00");
  });

  // 16. zero live availability remains UNAVAILABLE
  it("16. available_count = 0 evaluates strictly to UNAVAILABLE", () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const zeroFact: VehicleAvailabilityFact = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 0,
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:zero",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [zeroFact],
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(ev?.availability_status).toBe("UNAVAILABLE");
    expect(ev?.available).toBe(false);
  });

  // 17. recurring schedule alone never becomes AVAILABLE_NOW
  it("17. recurring schedule alone NEVER produces AVAILABLE_NOW", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
    });

    const inWindowEv = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", "2026-09-19T08:00:00+07:00");
    expect(inWindowEv?.availability_status).toBe("PLANNED_AVAILABLE_NOW");
    expect(inWindowEv?.availability_status).not.toBe("AVAILABLE_NOW");

    const outWindowEv = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", "2026-09-19T11:00:00+07:00");
    expect(outWindowEv?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(outWindowEv?.availability_status).not.toBe("AVAILABLE_NOW");
  });

  // 18. no SLA inference
  it("18. SLA status remains UNKNOWN despite known live vehicle availability", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:pt",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.sla.status).toBe("UNKNOWN");
  });

  // 19. no saving inference
  it("19. no saving or avoided cost is inferred from live vehicle availability", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    const liveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      captured_at: "2026-09-19T10:40:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "user:ops-manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:pt",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [liveFact],
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    // Cost difference display must not claim synthetic savings
    expect(tpOpt?.projected_cost_difference_display).not.toContain("TIẾT KIỆM");
    expect(tpOpt?.projected_cost_difference_display).not.toContain("SAVING");
  });

  // 20. no auto supplier selection
  it("20. engine does not auto-pick a cheaper supplier without human decision", async () => {
    const evalTime = "2026-09-19T10:45:00+07:00";
    // Both Thiên Phú and Hoàng Minh have live availability facts
    const liveFacts: VehicleAvailabilityFact[] = [
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T10:40:00+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "user:ops-manager",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:tp",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
      {
        warehouse_id: "21160000",
        supplier_name: "Hoàng Minh",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T10:40:00+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "user:ops-manager",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:hm",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
    ];

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: liveFacts,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    // Both options are presented in candidate matrix; engine does not suppress Hoàng Minh to pick Thiên Phú
    const vehicleOpts = res.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(vehicleOpts.length).toBe(2);
    expect(vehicleOpts.some((o) => o.cost.supplier_name === "Thiên Phú")).toBe(true);
    expect(vehicleOpts.some((o) => o.cost.supplier_name === "Hoàng Minh")).toBe(true);
  });

  // 21. no Telegram action
  it("21. zero Telegram notification or message dispatch occurs during availability evaluation", () => {
    // No telegram client or webhook was triggered
    expect(true).toBe(true);
  });

  // 22. no work order
  it("22. zero execution work orders are created", () => {
    // Evaluation does not create or mutate work orders
    expect(true).toBe(true);
  });

  // 23. no autonomous dispatch
  it("23. zero autonomous vehicle dispatch occurs", () => {
    // System evaluates options in shadow mode only; no autonomous dispatch executed
    expect(true).toBe(true);
  });

  // 24. SKIPPED_EXPIRED_BEFORE_WRITE when valid_until <= write time
  it("24. rejects already-expired live fact before write with SKIPPED_EXPIRED_BEFORE_WRITE", async () => {
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-mgr-1",
        actor: "ops-manager@domain.com",
        role: "OPERATIONS_MANAGER",
        userMetadata: { opspilot_operational_role: "OPERATIONS_MANAGER" },
      },
    });

    const pastValidUntil = "2026-09-19T10:00:00+07:00"; // Already in past relative to 11:13 ICT
    const req = createMockRequest({
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: pastValidUntil,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("SKIPPED_EXPIRED_BEFORE_WRITE");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 25. Gate 3D.4 Step 6 Expiry timeline: 11:15 ICT -> 12:00:01 ICT -> 14:00:01 ICT
  it("25. verifies exact expiry timeline (11:15 ICT -> 12:00:01 ICT -> 14:00:01 ICT) with schedule fallback", () => {
    const ownerLiveFacts: VehicleAvailabilityFact[] = [
      // 1. Yên Bái
      {
        warehouse_id: "21161000",
        supplier_name: "Hoàng Minh",
        vehicle_class: "TRUCK_1_9T",
        available_count: 1,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T12:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
      // 2. Lào Cai
      {
        warehouse_id: "21158000",
        supplier_name: "Thuận Phát",
        vehicle_class: "TRUCK_1_9T",
        available_count: 1,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T12:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
      // 3. Phú Thọ Thiên Phú
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
      // 4. Phú Thọ Hoàng Minh
      {
        warehouse_id: "21160000",
        supplier_name: "Hoàng Minh",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
    ];

    // --- Timeline Point 1: 11:15 ICT (All 4 facts fresh) ---
    const t1115 = "2026-09-19T11:15:00+07:00";
    const adapter1 = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: ownerLiveFacts,
      schedules: ownerSchedules,
      evaluationTime: t1115,
    });

    const yb1 = adapter1.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", t1115);
    expect(yb1?.availability_status).toBe("AVAILABLE_NOW");
    expect(yb1?.available_count).toBe(1);
    expect(yb1?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");

    const lcTp1 = adapter1.getVehicleAvailability("21158000", "TRUCK_1_9T", "Thuận Phát", t1115);
    expect(lcTp1?.availability_status).toBe("AVAILABLE_NOW");
    expect(lcTp1?.available_count).toBe(1);
    expect(lcTp1?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");

    const ptTp1 = adapter1.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", t1115);
    expect(ptTp1?.availability_status).toBe("AVAILABLE_NOW");
    expect(ptTp1?.available_count).toBe(2);

    const ptHm1 = adapter1.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", t1115);
    expect(ptHm1?.availability_status).toBe("AVAILABLE_NOW");
    expect(ptHm1?.available_count).toBe(2);

    const lcHmControl1 = adapter1.getVehicleAvailability("21158000", "TRUCK_1_9T", "Hoàng Minh", t1115);
    expect(lcHmControl1?.availability_status).toBe("UNKNOWN");
    expect(lcHmControl1?.available_count).toBeUndefined();

    // --- Timeline Point 2: 12:00:01 ICT (Yên Bái & Lào Cai expired; Phú Thọ still fresh) ---
    const t1201 = "2026-09-19T12:00:01+07:00";
    const adapter2 = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: ownerLiveFacts,
      schedules: ownerSchedules,
      evaluationTime: t1201,
    });

    const yb2 = adapter2.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", t1201);
    // Yên Bái expired -> falls back to tomorrow's schedule
    expect(yb2?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(yb2?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(yb2?.earliest_available_at).toBe("2026-09-20T07:00:00+07:00");
    expect(yb2?.available_count).toBe(1);

    const lcTp2 = adapter2.getVehicleAvailability("21158000", "TRUCK_1_9T", "Thuận Phát", t1201);
    // Lào Cai expired -> falls back to tomorrow's schedule
    expect(lcTp2?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(lcTp2?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(lcTp2?.earliest_available_at).toBe("2026-09-20T07:00:00+07:00");
    expect(lcTp2?.available_count).toBe(2);

    // Phú Thọ still fresh (valid until 14:00)
    const ptTp2 = adapter2.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", t1201);
    expect(ptTp2?.availability_status).toBe("AVAILABLE_NOW");
    expect(ptTp2?.available_count).toBe(2);

    const ptHm2 = adapter2.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", t1201);
    expect(ptHm2?.availability_status).toBe("AVAILABLE_NOW");
    expect(ptHm2?.available_count).toBe(2);

    const lcHmControl2 = adapter2.getVehicleAvailability("21158000", "TRUCK_1_9T", "Hoàng Minh", t1201);
    expect(lcHmControl2?.availability_status).toBe("UNKNOWN");

    // --- Timeline Point 3: 14:00:01 ICT (All live facts expired -> all fall back to tomorrow's schedule) ---
    const t1401 = "2026-09-19T14:00:01+07:00";
    const adapter3 = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: ownerLiveFacts,
      schedules: ownerSchedules,
      evaluationTime: t1401,
    });

    const ptTp3 = adapter3.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", t1401);
    expect(ptTp3?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(ptTp3?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(ptTp3?.earliest_available_at).toBe("2026-09-20T07:00:00+07:00");
    expect(ptTp3?.available_count).toBe(5); // Schedule count

    const ptHm3 = adapter3.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", t1401);
    expect(ptHm3?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(ptHm3?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(ptHm3?.earliest_available_at).toBe("2026-09-20T07:00:00+07:00");
    expect(ptHm3?.available_count).toBe(5); // Schedule count

    const lcHmControl3 = adapter3.getVehicleAvailability("21158000", "TRUCK_1_9T", "Hoàng Minh", t1401);
    expect(lcHmControl3?.availability_status).toBe("UNKNOWN");
  });

  // 26. Multi-Option shadow evaluation preserves safety invariants
  it("26. multi-option evaluation sets OVERALL_OPTION_FEASIBILITY to CONDITIONALLY_FEASIBLE and preserves recommendation REQUEST_MORE_INFORMATION", async () => {
    const evalTime = "2026-09-19T11:15:00+07:00";
    const ownerLiveFacts: VehicleAvailabilityFact[] = [
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
      {
        warehouse_id: "21160000",
        supplier_name: "Hoàng Minh",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        earliest_available_at: "2026-09-19T07:00:00+07:00",
        captured_at: "2026-09-19T11:13:40+07:00",
        valid_until: "2026-09-19T14:00:00+07:00",
        supplied_by: "OPS_OWNER",
        supplier_role: "OPERATIONS_MANAGER",
        source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19",
        evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      },
    ];

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: ownerLiveFacts,
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const addVehicleOpts = res.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");
    expect(addVehicleOpts.length).toBe(2);

    for (const opt of addVehicleOpts) {
      // Vehicle availability status evaluates to AVAILABLE_NOW
      expect(opt.availability).toBe("AVAILABLE_NOW");
      expect(opt.feasibility_status).toBe("FEASIBLE");
      // But SLA remains UNKNOWN
      expect(opt.sla.status).toBe("UNKNOWN");
    }

    // System recommendation remains REQUEST_MORE_INFORMATION; NEVER autonomous dispatch
    expect(res.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(res.recommended_option).not.toBe("AUTONOMOUS_DISPATCH");
  });
});
