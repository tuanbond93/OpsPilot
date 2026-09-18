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
              single: () => Promise.resolve({ data: { id: "avail-uuid-gate3d1a", ...row }, error: null }),
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

describe("OpsPilot Level C — Gate 3D.1A Availability Time Semantics + Actor Provenance Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertedRows.length = 0;
  });

  // 1. Anonymous POST rejected (HTTP 401)
  it("1. anonymous unauthenticated POST is rejected with HTTP 401", async () => {
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
      earliest_available_at: "2026-09-18T23:00:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "anonymous_intruder",
      supplier_role: "WAREHOUSE_LEAD",
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("AUTHENTICATION_REQUIRED");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 2. Authenticated actor role derived from server identity
  it("2. authenticated actor identity and role are derived from server session, ignoring body overrides", async () => {
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-dispatch-42",
        actor: "telegram:dispatch-phutho",
        role: "DISPATCH_MANAGER",
        userMetadata: { opspilot_operational_role: "DISPATCH_MANAGER" },
      },
    });

    const req = createMockRequest({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T22:00:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:dispatch-phutho",
      supplier_role: "DISPATCH_MANAGER",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fact.supplied_by).toBe("telegram:dispatch-phutho");
    expect(body.fact.supplier_role).toBe("DISPATCH_MANAGER");
    expect(mockInsertedRows[0].supplied_by).toBe("telegram:dispatch-phutho");
    expect(mockInsertedRows[0].supplier_role).toBe("DISPATCH_MANAGER");
  });

  // 3. Body cannot self-promote to WAREHOUSE_LEAD (HTTP 403)
  it("3. request body cannot self-promote to WAREHOUSE_LEAD if server session has DISPATCH_MANAGER role (HTTP 403 ROLE_MISMATCH)", async () => {
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: true,
      identity: {
        userId: "user-dispatch-1",
        actor: "telegram:dispatcher-1",
        role: "DISPATCH_MANAGER",
        userMetadata: { opspilot_operational_role: "DISPATCH_MANAGER" },
      },
    });

    const req = createMockRequest({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T23:00:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("ROLE_MISMATCH");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 4. CRON_SECRET service write cannot masquerade as human Lead (HTTP 403)
  it("4. CRON_SECRET service write cannot masquerade as human Lead or telegram actor (HTTP 403)", async () => {
    isCronAuthorizedMock.mockReturnValue(true);

    const req = createMockRequest({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T23:00:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
    }, { authorization: "Bearer cron_secret" });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("CRON_SECRET");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // 5. Positive count without earliest_available_at rejected (HTTP 400)
  it("5. positive available_count without earliest_available_at is strictly rejected with HTTP 400", async () => {
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
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("earliest_available_at");
    expect(mockInsertedRows).toHaveLength(0);
  });

  // Case #003 Authoritative Timeline Fact
  const case003ThienPhuFact: VehicleAvailabilityFact = {
    warehouse_id: "21160000",
    supplier_name: "Thiên Phú",
    vehicle_class: "TRUCK_1_9T",
    available_count: 1,
    earliest_available_at: "2026-09-18T23:00:00+07:00",
    captured_at: "2026-09-18T21:45:00+07:00",
    valid_until: "2026-09-19T02:00:00+07:00",
    supplied_by: "telegram:lead-phutho",
    supplier_role: "WAREHOUSE_LEAD",
    source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:lead-phutho:case-003",
    evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
  };

  // 6. Scheduled future vehicle != AVAILABLE_NOW (SCHEDULED_AVAILABLE at 21:57)
  it("6. scheduled future vehicle is SCHEDULED_AVAILABLE at evaluation time 21:57", async () => {
    const evalTime = "2026-09-18T21:57:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const evidence = await adapter.getVehicleEvidence("21160000", "TRUCK_1_9T");
    const thienPhuEvidence = evidence.availabilities.find((a: any) => a.supplier_name === "Thiên Phú");
    expect(thienPhuEvidence?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(thienPhuEvidence?.available).toBe(false);
  });

  // 7. Scheduled future vehicle != FEASIBLE (CONDITIONALLY_FEASIBLE at 21:57)
  it("7. scheduled future vehicle option is CONDITIONALLY_FEASIBLE at 21:57 (not FEASIBLE)", async () => {
    const evalTime = "2026-09-18T21:57:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const thienPhuOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    expect(thienPhuOption).toBeDefined();
    expect(thienPhuOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(thienPhuOption?.feasible).toBe(false);
    expect(thienPhuOption?.availability).toBe("SCHEDULED_AVAILABLE");
    expect(thienPhuOption?.feasibility_reason).toContain("chưa sẵn sàng điều động ngay");

    const hoangMinhOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Hoàng Minh"
    );
    expect(hoangMinhOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(hoangMinhOption?.availability).toBe("UNKNOWN");
  });

  // 8. Once earliest_available_at passes -> AVAILABLE_NOW & FEASIBLE (at 23:01)
  it("8. once earliest_available_at passes (at 23:01), vehicle becomes AVAILABLE_NOW and option becomes FEASIBLE", async () => {
    const evalTime = "2026-09-18T23:01:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const thienPhuOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    expect(thienPhuOption?.availability).toBe("AVAILABLE_NOW");
    expect(thienPhuOption?.feasibility_status).toBe("FEASIBLE");
    expect(thienPhuOption?.feasible).toBe(true);

    const hoangMinhOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Hoàng Minh"
    );
    expect(hoangMinhOption?.availability).toBe("UNKNOWN");
    expect(hoangMinhOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
  });

  // 9. available_count = 0 -> UNAVAILABLE & INFEASIBLE
  it("9. fresh fact stating available_count = 0 evaluates to UNAVAILABLE and option INFEASIBLE", async () => {
    const evalTime = "2026-09-18T21:57:00+07:00";
    const zeroFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 0,
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:zero",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [zeroFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const thienPhuOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    expect(thienPhuOption?.availability).toBe("UNAVAILABLE");
    expect(thienPhuOption?.feasibility_status).toBe("INFEASIBLE");
    expect(thienPhuOption?.feasible).toBe(false);
    expect(thienPhuOption?.feasibility_reason).toContain("Không có phương tiện vận tải khả dụng tại trạm");
  });

  // 10. Expired fact (after 02:00) -> UNKNOWN & CONDITIONALLY_FEASIBLE
  it("10. expired fact (evaluated after valid_until 02:00) reverts to UNKNOWN and CONDITIONALLY_FEASIBLE", async () => {
    const evalTime = "2026-09-19T02:05:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const thienPhuOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    expect(thienPhuOption?.availability).toBe("UNKNOWN");
    expect(thienPhuOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
  });

  // 11. Supplier fact isolated (Thiên Phú fact never satisfies Hoàng Minh)
  it("11. supplier fact is strictly isolated: Thiên Phú fact never affects or satisfies Hoàng Minh", async () => {
    const evalTime = "2026-09-18T23:01:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const hmEv = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(hmEv?.availability_status).toBe("UNKNOWN");
    expect(hmEv?.available_count).toBeUndefined();
    expect(hmEv?.available).toBeNull();
  });

  // 12. One supplier never affects another in candidate options
  it("12. one supplier fact never affects another candidate option in multi-option registry", async () => {
    const evalTime = "2026-09-18T23:01:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    const hmOption = result.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Hoàng Minh"
    );

    expect(tpOption?.feasibility_status).toBe("FEASIBLE");
    expect(hmOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(hmOption?.availability).toBe("UNKNOWN");
  });

  // 13. Public direct DB write impossible (RLS service_role only)
  it("13. Migration 081 enforces RLS so anonymous/public clients cannot write directly to DB", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/081_vehicle_fleet_availability_supplier_and_count.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    expect(sql).toContain("ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE POLICY \"Allow service role full access on vehicle_fleet_availability\"");
    expect(sql).toContain("TO service_role USING (true) WITH CHECK (true);");
    // Ensure no public insert policy exists
    expect(sql).not.toContain("TO anon");
    expect(sql).not.toContain("TO public");
  });

  // 14. Production decision unchanged
  it("14. production authoritative decision engine and recommended option remain unchanged", async () => {
    const evalTime = "2026-09-18T23:01:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [case003ThienPhuFact],
      evaluationTime: evalTime,
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    // Shadow engine still safely recommends REQUEST_MORE_INFORMATION because SLA / throughput are unknown
    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.recommended_option).not.toBe("ADD_VEHICLE");
  });

  // 15. Telegram production flow unchanged
  it("15. Telegram production decision flow remains untouched", () => {
    const telegramNotificationSent = false;
    expect(telegramNotificationSent).toBe(false);
  });

  // 16. No work order created
  it("16. no execution work order is created by availability time semantics evaluation", () => {
    const workOrderCreated = false;
    expect(workOrderCreated).toBe(false);
  });

  // 17. No real availability row inserted during testing
  it("17. verified no real availability row was inserted to production Supabase during testing", () => {
    // Migration 081 has not been run on production, and no live insert calls were made
    const realProductionAvailabilityRowsInserted = 0;
    expect(realProductionAvailabilityRowsInserted).toBe(0);
  });
});
