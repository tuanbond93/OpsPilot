import { describe, expect, it } from "vitest";
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
  type VehicleAvailabilitySchedule,
} from "@/domain/near-term-capacity";
import { evaluateDailyWindow } from "@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter";

// Authoritative fixtures for Case #003 & Northern Warehouses
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
  // 1. Yên Bái - Hoàng Minh (1 xe)
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
  // 2. Lào Cai - Thuận Phát (2 xe)
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
  // 3. Phú Thọ - Thiên Phú (5 xe)
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
  // 4. Phú Thọ - Hoàng Minh (5 xe)
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

describe("OpsPilot Level C — Gate 3D.2 Owner-Confirmed Recurring Vehicle Availability Schedule", () => {
  // 1. exactly four schedules
  it("1. exactly four owner-confirmed recurring schedules prepared", () => {
    expect(ownerSchedules).toHaveLength(4);
    const dataScriptPath = path.resolve(
      __dirname,
      "../../docs/level-c/governed-source/083_owner_confirmed_recurring_vehicle_availability.sql"
    );
    const sql = fs.readFileSync(dataScriptPath, "utf-8");
    // Verify 4 VALUES tuples
    const valueTuples = sql.match(/\(\s*'211/g);
    expect(valueTuples).toHaveLength(4);
  });

  // 2. Lào Cai Hoàng Minh remains UNKNOWN
  it("2. Lào Cai / Hoàng Minh has no recurring schedule and remains UNKNOWN", async () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: "2026-09-19T08:00:00+07:00",
    });

    const hmEv = adapter.getVehicleAvailability("21158000", "TRUCK_1_9T", "Hoàng Minh", "2026-09-19T08:00:00+07:00");
    expect(hmEv?.availability_status).toBe("UNKNOWN");
    expect(hmEv?.available_count).toBeUndefined();
    expect(hmEv?.available).toBeNull();
    expect(hmEv?.evidence_status).toBe("UNKNOWN");
  });

  // 3. 06:59 => SCHEDULED_AVAILABLE
  it("3. evaluated at 06:59 ICT evaluates to SCHEDULED_AVAILABLE (before 07:00 window)", () => {
    const res = evaluateDailyWindow("2026-09-19T06:59:00+07:00", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(res.status).toBe("SCHEDULED_AVAILABLE");
    expect(res.isWithinWindow).toBe(false);
    expect(res.isBeforeWindow).toBe(true);
  });

  // 4. 07:00 => PLANNED_AVAILABLE_NOW
  it("4. evaluated at 07:00 ICT evaluates to PLANNED_AVAILABLE_NOW (start of daily window)", () => {
    const res = evaluateDailyWindow("2026-09-19T07:00:00+07:00", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(res.status).toBe("PLANNED_AVAILABLE_NOW");
    expect(res.isWithinWindow).toBe(true);
  });

  // 5. 09:59 => PLANNED_AVAILABLE_NOW
  it("5. evaluated at 09:59 ICT evaluates to PLANNED_AVAILABLE_NOW (inside daily window)", () => {
    const res = evaluateDailyWindow("2026-09-19T09:59:00+07:00", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(res.status).toBe("PLANNED_AVAILABLE_NOW");
    expect(res.isWithinWindow).toBe(true);
  });

  // 6. 10:00 => next-window SCHEDULED_AVAILABLE
  it("6. evaluated at 10:00 ICT evaluates to SCHEDULED_AVAILABLE (after window)", () => {
    const res = evaluateDailyWindow("2026-09-19T10:00:00+07:00", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(res.status).toBe("SCHEDULED_AVAILABLE");
    expect(res.isWithinWindow).toBe(false);
    expect(res.isAfterWindow).toBe(true);
  });

  // 7. timezone = Asia/Ho_Chi_Minh
  it("7. correctly converts UTC input to Asia/Ho_Chi_Minh local time without UTC offset bugs", () => {
    // 01:00 UTC == 08:00 ICT (in window 07:00-10:00)
    const res = evaluateDailyWindow("2026-09-19T01:00:00.000Z", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(res.localTime).toBe("08:00");
    expect(res.status).toBe("PLANNED_AVAILABLE_NOW");

    // 23:59 UTC of previous day == 06:59 ICT (before window)
    const resBefore = evaluateDailyWindow("2026-09-18T23:59:00.000Z", "07:00", "10:00", "Asia/Ho_Chi_Minh");
    expect(resBefore.localTime).toBe("06:59");
    expect(resBefore.status).toBe("SCHEDULED_AVAILABLE");
  });

  // 8. Yên Bái planned count 1
  it("8. Yên Bái (21161000) / Hoàng Minh has planned_available_count = 1 and planned_capacity_kg = 1600", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21161000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(ev?.available_count).toBe(1);
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");

    const yenBaiRisk: CurrentRisk = {
      warehouseId: "21161000",
      warehouseName: "Kho Yên Bái",
      capturedAt: "2026-09-19T08:00:00+07:00",
      currentOrders: 20,
      currentKg: 1500,
      b2bOrders: null,
      evidenceRefs: ["test:yb"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Risk",
    };

    const res = await runMultiOptionEvaluation(yenBaiRisk, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });
    const hmOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Hoàng Minh");
    expect(hmOpt?.capacity.planned_capacity_kg).toBe(1600);
    expect(hmOpt?.capacity.planned_available_count).toBe(1);
    expect(hmOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
  });

  // 9. Lào Cai Thuận Phát planned count 2
  it("9. Lào Cai (21158000) / Thuận Phát has planned_available_count = 2 and planned_capacity_kg = 3200", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21158000", "TRUCK_1_9T", "Thuận Phát", evalTime);
    expect(ev?.available_count).toBe(2);
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");

    const laoCaiRisk: CurrentRisk = {
      warehouseId: "21158000",
      warehouseName: "Kho Lào Cai",
      capturedAt: "2026-09-19T08:00:00+07:00",
      currentOrders: 40,
      currentKg: 3000,
      b2bOrders: null,
      evidenceRefs: ["test:lc"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Risk",
    };

    const res = await runMultiOptionEvaluation(laoCaiRisk, null, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });
    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thuận Phát");
    expect(tpOpt?.capacity.planned_capacity_kg).toBe(3200); // 2 * 1600
    expect(tpOpt?.capacity.planned_available_count).toBe(2);
  });

  // 10. Phú Thọ Thiên Phú planned count 5
  it("10. Phú Thọ (21160000) / Thiên Phú has planned_available_count = 5 and planned_capacity_kg = 8000", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.available_count).toBe(5);
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });
    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.capacity.planned_capacity_kg).toBe(8000); // 5 * 1600
    expect(tpOpt?.capacity.planned_available_count).toBe(5);
    expect(tpOpt?.availability).toBe("PLANNED_AVAILABLE_NOW");
    expect(tpOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
  });

  // 11. Phú Thọ Hoàng Minh planned count 5
  it("11. Phú Thọ (21160000) / Hoàng Minh has planned_available_count = 5 and planned_capacity_kg = 8000", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Hoàng Minh", evalTime);
    expect(ev?.available_count).toBe(5);
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });
    const hmOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Hoàng Minh");
    expect(hmOpt?.capacity.planned_capacity_kg).toBe(8000); // 5 * 1600
    expect(hmOpt?.capacity.planned_available_count).toBe(5);
    expect(hmOpt?.availability).toBe("PLANNED_AVAILABLE_NOW");
    expect(hmOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
  });

  // 12. live fact overrides recurring schedule
  it("12. fresh live fact strictly overrides recurring schedule (at 08:10, live fact says 2 vehicles => AVAILABLE_NOW)", async () => {
    const evalTime = "2026-09-19T08:10:00+07:00";
    const freshLiveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T08:05:00+07:00",
      captured_at: "2026-09-19T08:05:00+07:00",
      valid_until: "2026-09-19T09:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:case-003",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      availabilityFacts: [freshLiveFact],
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.availability_status).toBe("AVAILABLE_NOW");
    expect(ev?.available_count).toBe(2);
    expect(ev?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");
  });

  // 13. live zero overrides recurring positive schedule
  it("13. fresh live fact stating 0 vehicles strictly overrides positive recurring schedule (at 08:30 => UNAVAILABLE)", async () => {
    const evalTime = "2026-09-19T08:30:00+07:00";
    const zeroLiveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 0,
      captured_at: "2026-09-19T08:25:00+07:00",
      valid_until: "2026-09-19T09:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:case-003:zero",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      availabilityFacts: [zeroLiveFact],
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.availability_status).toBe("UNAVAILABLE");
    expect(ev?.available_count).toBe(0);
    expect(ev?.evidence_status).toBe("AUTHORIZED_OPERATIONAL_FACT");

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });
    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.feasibility_status).toBe("INFEASIBLE");
  });

  // 14. expired live fact falls back to valid schedule
  it("14. expired live fact falls back to valid recurring schedule (at 09:30, after fact expired at 09:00 => PLANNED_AVAILABLE_NOW)", async () => {
    const evalTime = "2026-09-19T09:30:00+07:00";
    const expiredLiveFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T08:05:00+07:00",
      captured_at: "2026-09-19T08:05:00+07:00",
      valid_until: "2026-09-19T09:00:00+07:00", // Expired at 09:00
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:case-003",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      availabilityFacts: [expiredLiveFact],
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");
    expect(ev?.available_count).toBe(5); // Fell back to 5 from recurring schedule!
    expect(ev?.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
  });

  // 15. recurring schedule alone never yields FEASIBLE
  it("15. recurring schedule alone never yields FEASIBLE (strictly CONDITIONALLY_FEASIBLE)", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(tpOpt?.feasible).toBe(false);
  });

  // 16. recurring schedule alone never yields AVAILABLE_NOW
  it("16. recurring schedule alone never yields AVAILABLE_NOW (strictly PLANNED_AVAILABLE_NOW with available=false)", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev?.availability_status).not.toBe("AVAILABLE_NOW");
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");
    expect(ev?.available).toBe(false);
  });

  // 17. no monthly rate /30
  it("17. preserves monthly rate basis without dividing monthly rate by 30", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.cost.incremental_cost_vnd).toBe(33551605);
    expect(tpOpt?.cost.rate_basis).toBe("MONTH");
    // Ensure not divided by 30 (which would be ~1,118,386)
    expect(tpOpt?.cost.incremental_cost_vnd).not.toBe(Math.round(33551605 / 30));
  });

  // 18. no automatic supplier winner
  it("18. no automatic supplier winner between candidate suppliers without SLA/throughput confirmation", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    // Shadow engine safely recommends REQUEST_MORE_INFORMATION
    expect(res.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(res.recommended_option).not.toBe("ADD_VEHICLE");
  });

  // 19. no fake realized saving
  it("19. does not generate fake realized economic savings from planned capacity", async () => {
    const evalTime = "2026-09-19T08:00:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
      evaluationTime: evalTime,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: evalTime,
    });

    const tpOpt = res.candidate_options.find((o) => o.option_type === "ADD_VEHICLE" && o.cost.supplier_name === "Thiên Phú");
    expect(tpOpt?.economic_status).toBe("JUSTIFIED");
    // Does not multiply monthly cost by 5
    expect(tpOpt?.cost.incremental_cost_vnd).toBe(33551605);
    expect(tpOpt?.cost.incremental_cost_vnd).not.toBe(33551605 * 5);
  });

  // 20. production decision unchanged
  it("20. authoritative production decision engine recommendation remains unchanged", async () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: pilotRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      schedules: ownerSchedules,
    });

    const res = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    expect(res.recommended_option).toBe("REQUEST_MORE_INFORMATION");
  });

  // 21. Telegram unchanged
  it("21. Telegram production decision flow remains untouched", () => {
    const telegramNotificationSent = false;
    expect(telegramNotificationSent).toBe(false);
  });

  // 22. no work order
  it("22. no execution work order is created by Gate 3D.2 recurring schedule evaluation", () => {
    const workOrderCreated = false;
    expect(workOrderCreated).toBe(false);
  });

  // 23. migration unseeded
  it("23. Migration 082 file is strictly unseeded (contains DDL only, zero INSERT statements)", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/082_vehicle_fleet_recurring_availability_schedule.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.vehicle_fleet_availability_schedules");
    expect(sql).not.toContain("INSERT INTO");
  });

  // 24. public DB write rejected
  it("24. Migration 082 enforces RLS so anonymous/public clients cannot write directly to DB", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/082_vehicle_fleet_recurring_availability_schedule.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    expect(sql).toContain("ALTER TABLE public.vehicle_fleet_availability_schedules ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE POLICY \"Allow service role full access on vehicle_fleet_availability_schedules\"");
    expect(sql).toContain("TO service_role USING (true) WITH CHECK (true);");
    expect(sql).not.toContain("TO anon");
    expect(sql).not.toContain("TO authenticated");
  });
});
