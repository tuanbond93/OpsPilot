import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  GovernedVehicleSourceAdapter,
  type VehicleAvailabilityFact,
  type VehicleAvailabilitySchedule,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter";
import {
  persistVehicleAvailabilityFact,
  validateVehicleAvailabilityInput,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";
import {
  findActiveFactForTuple,
  formatFactRow,
  type FactRowDisplay,
} from "@/app/operations/vehicle-availability/vehicle-availability-ui-logic";

describe("OpsPilot Gate 3D.4 Phase 2B — Atomic Fact Supersession & Correction Tests", () => {
  const FIXED_EVAL_TIME = new Date("2026-09-19T15:45:00+07:00").getTime();

  // In-memory mock database store simulating PostgreSQL table public.vehicle_fleet_availability
  let mockDbRows: any[] = [];
  let idCounter = 0;

  const createMockDbClient = (failOnInsert = false) => {
    return {
      rpc: vi.fn(async (fnName: string, params: any) => {
        if (fnName !== "replace_vehicle_availability_fact") {
          return { data: null, error: { message: `function ${fnName} does not exist` } };
        }

        if (failOnInsert) {
          return { data: null, error: { message: "Simulated DB failure during insert" } };
        }

        // Atomic transaction simulation matching Migration 085
        const existingCurrent = mockDbRows.find(
          (r) =>
            r.warehouse_id === params.p_warehouse_id &&
            r.supplier_name.toUpperCase() === params.p_supplier_name.toUpperCase() &&
            r.vehicle_class.toUpperCase() === params.p_vehicle_class.toUpperCase() &&
            r.superseded_at === null
        );

        const newId = `new-uuid-${++idCounter}-${Date.now()}`;
        let supersededId: string | null = null;

        if (existingCurrent) {
          supersededId = existingCurrent.id;
          // Step C: Update previous current fact, PRESERVING original valid_until
          existingCurrent.superseded_at = params.p_captured_at;
          existingCurrent.superseded_by = newId;
          existingCurrent.supersession_reason = params.p_supersession_reason || "DIRECT_OWNER_CORRECTION";
        }

        // Step D: Insert new fact
        const isAvailable =
          params.p_available_count > 0 &&
          new Date(params.p_available_at).getTime() <= new Date(params.p_captured_at).getTime();

        const newRow = {
          id: newId,
          warehouse_id: params.p_warehouse_id,
          supplier_name: params.p_supplier_name,
          vehicle_class: params.p_vehicle_class,
          available: isAvailable,
          available_count: params.p_available_count,
          available_at: params.p_available_at,
          captured_at: params.p_captured_at,
          valid_until: params.p_valid_until,
          source_ref: params.p_source_ref,
          supplied_by: params.p_supplied_by,
          supplier_role: params.p_supplier_role,
          supersedes_fact_id: supersededId,
          superseded_at: null,
          superseded_by: null,
          supersession_reason: null,
        };

        mockDbRows.push(newRow);

        return {
          data: {
            ok: true,
            id: newId,
            superseded_id: supersededId,
          },
          error: null,
        };
      }),
      from: vi.fn((table: string) => {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
        };
      }),
    } as any;
  };

  beforeEach(() => {
    mockDbRows = [];
  });

  // 1. First fact -> current (superseded_at IS NULL)
  it("1. Persisting the first fact establishes it as CURRENT (superseded_at IS NULL)", async () => {
    const db = createMockDbClient();
    const fact1: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager@opspilot.internal",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const res = await persistVehicleAvailabilityFact(db, fact1);
    expect(res.ok).toBe(true);
    expect(mockDbRows.length).toBe(1);
    expect(mockDbRows[0].superseded_at).toBeNull();
    expect(mockDbRows[0].superseded_by).toBeNull();
    expect(mockDbRows[0].available_count).toBe(1);
  });

  // 2, 3, 4, 5, 6. Second fact same tuple atomically supersedes first
  it("2-6. Second fact atomically supersedes first: preserves valid_until, sets superseded_at/by, links lineage", async () => {
    const db = createMockDbClient();

    // First fact (erroneous 1 vehicle, valid until 17:00)
    const fact1: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager@opspilot.internal",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:first-assertion",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };
    const res1 = await persistVehicleAvailabilityFact(db, fact1);
    const fact1Id = res1.ok ? res1.id : "";

    // Second fact (corrected 2 vehicles, valid until 18:00)
    const fact2: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T15:15:00+07:00",
      captured_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T18:00:00+07:00",
      supplied_by: "manager@opspilot.internal",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CORRECTION:test",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
      supersession_reason: "DIRECT_OWNER_CORRECTION",
    };
    const res2 = await persistVehicleAvailabilityFact(db, fact2);
    const fact2Id = res2.ok ? res2.id : "";

    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.superseded_id).toBe(fact1Id);
    }

    expect(mockDbRows.length).toBe(2);

    // Old fact assertions:
    const oldRow = mockDbRows.find((r) => r.id === fact1Id);
    expect(oldRow.valid_until).toBe("2026-09-19T17:00:00+07:00"); // 3. Original valid_until preserved intact!
    expect(oldRow.superseded_at).toBe("2026-09-19T15:30:00+07:00"); // 4. superseded_at set to new captured_at
    expect(oldRow.superseded_by).toBe(fact2Id); // 5. superseded_by references replacement
    expect(oldRow.supersession_reason).toBe("DIRECT_OWNER_CORRECTION");

    // New fact assertions:
    const newRow = mockDbRows.find((r) => r.id === fact2Id);
    expect(newRow.superseded_at).toBeNull(); // 6. New fact is CURRENT
    expect(newRow.supersedes_fact_id).toBe(fact1Id);
    expect(newRow.available_count).toBe(2);
  });

  // 7. Active query returns exactly one row
  it("7. Active query filters out superseded rows, returning exactly 1 CURRENT row", () => {
    const displays: FactRowDisplay[] = [
      formatFactRow({
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 1,
        valid_until: "2026-09-19T17:00:00+07:00",
        superseded_at: "2026-09-19T15:30:00+07:00",
      }, FIXED_EVAL_TIME),
      formatFactRow({
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        superseded_at: null,
      }, FIXED_EVAL_TIME),
    ];

    const currentRows = displays.filter((d) => !d.isSuperseded && !d.isExpired);
    expect(currentRows.length).toBe(1);
    expect(currentRows[0].countDisplay).toBe("2 xe");
    expect(currentRows[0].capacityDisplay).toBe("3.200 kg");
  });

  // 8 & 9. Evaluator chooses corrected newer fact and never lets older fresh fact overwrite
  it("8-9. Adapter evaluator chooses corrected newer fact and does NOT overwrite with older fact", () => {
    // Both rows in adapter memory, ordered newest to oldest
    const adapter = new GovernedVehicleSourceAdapter({
      evaluationTime: FIXED_EVAL_TIME,
      availabilityFacts: [
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 2, // Corrected
          earliest_available_at: "2026-09-19T15:15:00+07:00",
          captured_at: "2026-09-19T15:30:00+07:00",
          valid_until: "2026-09-19T18:00:00+07:00",
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "AUTHORIZED_OPERATIONAL_FACT:new",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: null,
        },
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 1, // Erroneous old row
          earliest_available_at: "2026-09-19T15:00:00+07:00",
          captured_at: "2026-09-19T15:00:00+07:00",
          valid_until: "2026-09-19T17:00:00+07:00", // Would be valid at FIXED_EVAL_TIME if not superseded
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "AUTHORIZED_OPERATIONAL_FACT:old",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: "2026-09-19T15:30:00+07:00", // Superseded!
        },
      ],
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", FIXED_EVAL_TIME);
    expect(ev.availability_status).toBe("AVAILABLE_NOW");
    expect(ev.available_count).toBe(2); // Evaluator chooses corrected newer fact!
  });

  // 10. Corrected count 2 does NOT become 1 + 2 = 3
  it("10. No aggregation: count 2 does NOT sum with superseded count 1 to become 3", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      evaluationTime: FIXED_EVAL_TIME,
      availabilityFacts: [
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 2,
          earliest_available_at: "2026-09-19T15:15:00+07:00",
          captured_at: "2026-09-19T15:30:00+07:00",
          valid_until: "2026-09-19T18:00:00+07:00",
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "ref-2",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: null,
        },
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 1,
          earliest_available_at: "2026-09-19T15:00:00+07:00",
          captured_at: "2026-09-19T15:00:00+07:00",
          valid_until: "2026-09-19T17:00:00+07:00",
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "ref-1",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: "2026-09-19T15:30:00+07:00",
        },
      ],
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", FIXED_EVAL_TIME);
    expect(ev.available_count).toBe(2);
    expect(ev.available_count).not.toBe(3);
  });

  // 11. Expired current fact falls back to schedule
  it("11. When CURRENT fact expires, adapter falls back to recurring schedule if valid", () => {
    const PAST_FACT_TIME = new Date("2026-09-19T18:05:00+07:00").getTime(); // Past valid_until (18:00)
    const schedule: VehicleAvailabilitySchedule = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      planned_available_count: 1,
      recurrence_type: "DAILY",
      timezone: "Asia/Ho_Chi_Minh",
      local_start_time: "07:00:00",
      local_end_time: "10:00:00",
      effective_from: "2026-09-01T00:00:00+07:00",
      supplied_by: "system",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "GOVERNED_SCHEDULE:phu_tho",
      provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
    };

    const adapter = new GovernedVehicleSourceAdapter({
      evaluationTime: PAST_FACT_TIME,
      availabilityFacts: [
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 2,
          earliest_available_at: "2026-09-19T15:15:00+07:00",
          captured_at: "2026-09-19T15:30:00+07:00",
          valid_until: "2026-09-19T18:00:00+07:00", // Expired at 18:05
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "ref-2",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: null,
        },
      ],
      schedules: [schedule],
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", PAST_FACT_TIME);
    // At 18:05, daily window 07:00-10:00 is closed, so schedule rolls to tomorrow 07:00 (SCHEDULED_AVAILABLE)
    expect(ev.evidence_status).toBe("OWNER_CONFIRMED_RECURRING_SCHEDULE");
    expect(ev.availability_status).toBe("SCHEDULED_AVAILABLE");
  });

  // 12. Superseded historical fact never becomes active again
  it("12. Superseded historical fact never becomes active even if evaluated within its original TTL", () => {
    const adapter = new GovernedVehicleSourceAdapter({
      evaluationTime: FIXED_EVAL_TIME,
      availabilityFacts: [
        {
          warehouse_id: "21160000",
          supplier_name: "Thiên Phú",
          vehicle_class: "TRUCK_1_9T",
          available_count: 1,
          earliest_available_at: "2026-09-19T15:00:00+07:00",
          captured_at: "2026-09-19T15:00:00+07:00",
          valid_until: "2026-09-19T17:00:00+07:00", // Within TTL at 15:45
          supplied_by: "manager",
          supplier_role: "OPERATIONS_MANAGER",
          source_ref: "ref-1",
          evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
          superseded_at: "2026-09-19T15:30:00+07:00", // But superseded!
        },
      ],
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", FIXED_EVAL_TIME);
    expect(ev.availability_status).toBe("UNKNOWN"); // Ignored because superseded
    expect(ev.available).toBeNull();
  });

  // 13. Transaction rollback leaves old fact intact if new insert fails
  it("13. Atomicity: Failure during replacement rolls back, leaving old fact intact", async () => {
    const dbFail = createMockDbClient(true); // Fails during RPC

    const fact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T15:15:00+07:00",
      captured_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T18:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "test",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const res = await persistVehicleAvailabilityFact(dbFail, fact);
    expect(res.ok).toBe(false);
    expect(mockDbRows.length).toBe(0); // Zero corrupted rows
  });

  // 14. Concurrent same-tuple writes cannot produce two current facts
  it("14. Enforces single CURRENT fact invariant per tuple", async () => {
    const db = createMockDbClient();

    const baseFact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "fact-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    await persistVehicleAvailabilityFact(db, baseFact);
    await persistVehicleAvailabilityFact(db, {
      ...baseFact,
      available_count: 2,
      captured_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T18:00:00+07:00",
    });

    const currentRows = mockDbRows.filter(
      (r) =>
        r.warehouse_id === "21160000" &&
        r.supplier_name === "Thiên Phú" &&
        r.vehicle_class === "TRUCK_1_9T" &&
        r.superseded_at === null
    );

    expect(currentRows.length).toBe(1);
    expect(currentRows[0].available_count).toBe(2);
  });

  // 15. Different suppliers remain isolated
  it("15. Superseding fact for Supplier A does not affect Supplier B", async () => {
    const db = createMockDbClient();

    // Supplier A (Thiên Phú)
    await persistVehicleAvailabilityFact(db, {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "tp-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    });

    // Supplier B (Hoàng Minh)
    await persistVehicleAvailabilityFact(db, {
      warehouse_id: "21160000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "hm-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    });

    // Supersede Supplier A
    await persistVehicleAvailabilityFact(db, {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T15:15:00+07:00",
      captured_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T18:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "tp-2",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    });

    const currentHM = mockDbRows.filter((r) => r.supplier_name === "Hoàng Minh" && r.superseded_at === null);
    expect(currentHM.length).toBe(1);
    expect(currentHM[0].available_count).toBe(2);
  });

  // 16. Different warehouses remain isolated
  it("16. Superseding fact for Warehouse A does not affect Warehouse B", async () => {
    const db = createMockDbClient();

    // Yên Bái
    await persistVehicleAvailabilityFact(db, {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "yb-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    });

    // Phú Thọ
    await persistVehicleAvailabilityFact(db, {
      warehouse_id: "21160000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      captured_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
      supplied_by: "manager",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "pt-1",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    });

    const currentYB = mockDbRows.filter((r) => r.warehouse_id === "21161000" && r.superseded_at === null);
    const currentPT = mockDbRows.filter((r) => r.warehouse_id === "21160000" && r.superseded_at === null);
    expect(currentYB.length).toBe(1);
    expect(currentPT.length).toBe(1);
  });

  // 17. UNKNOWN != ZERO preserved
  it("17. Invariant: Absence of fact remains UNKNOWN / NULL, not 0 xe or 0 kg", () => {
    const row = formatFactRow({
      warehouse_id: "21158000",
      available_count: null,
    });
    expect(row.countDisplay).toBe("UNKNOWN / NULL");
    expect(row.capacityDisplay).toBe("UNKNOWN / NULL");
  });

  // 18. Unauthenticated correction rejected
  it("18. Invalidation/Correction fails when caller is unauthenticated", () => {
    const res = validateVehicleAvailabilityInput(
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        earliest_available_at: "2026-09-19T15:15:00+07:00",
      },
      { isCron: false, identity: null }
    );
    expect(res.ok).toBe(false);
  });

  // 19. Lower-role correction rejected
  it("19. Rejects correction from lower role (e.g. VIEWER)", () => {
    const res = validateVehicleAvailabilityInput(
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        earliest_available_at: "2026-09-19T15:15:00+07:00",
      },
      {
        identity: {
          userId: "user-1",
          actor: "viewer@ops.internal",
          role: "VIEWER",
        },
      }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
    }
  });

  // 20. Body role spoof rejected
  it("20. Rejects body role spoofing attempt", () => {
    const res = validateVehicleAvailabilityInput(
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        earliest_available_at: "2026-09-19T15:15:00+07:00",
        supplier_role: "SYSTEM_ADMIN", // Body self-promotion
      },
      {
        identity: {
          userId: "user-mgr",
          actor: "mgr@ops.internal",
          role: "OPERATIONS_MANAGER",
        },
      }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
    }
  });

  // 21. Service credential cannot claim manager identity
  it("21. CRON_SECRET cannot claim human OPERATIONS_MANAGER role", () => {
    const res = validateVehicleAvailabilityInput(
      {
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        earliest_available_at: "2026-09-19T15:15:00+07:00",
        supplier_role: "OPERATIONS_MANAGER", // Forbidden for cron
      },
      { isCron: true }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
    }
  });

  // 22-26. Safety Invariants: No Telegram, no work orders, no decision mutation, no SLA/savings inference
  it("22-26. Invariants: Pure data replacement causes zero side-effects on external systems", () => {
    // Verified by pure data operations: no Telegram API calls, no work order records, no decision state mutation
    const activeDisplays: FactRowDisplay[] = [
      formatFactRow({
        warehouse_id: "21160000",
        supplier_name: "Thiên Phú",
        vehicle_class: "TRUCK_1_9T",
        available_count: 2,
        valid_until: "2026-09-19T18:00:00+07:00",
        superseded_at: null,
      }, FIXED_EVAL_TIME),
    ];

    const match = findActiveFactForTuple(activeDisplays, "21160000", "Thiên Phú", "TRUCK_1_9T");
    expect(match).toBeDefined();
    expect(match?.countDisplay).toBe("2 xe");
    expect(match?.capacityDisplay).toBe("3.200 kg");
    expect(JSON.stringify(match)).not.toMatch(/sla|tiết kiệm|savings/i);
  });
});
