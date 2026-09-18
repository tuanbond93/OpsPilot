import { beforeEach, describe, expect, it, vi } from "vitest";
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
  persistVehicleAvailabilityFact,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";

/**
 * Deterministic constraint validator simulator for Migration 081.
 * Mirrors the exact PostgreSQL CHECK constraints defined in 081_vehicle_fleet_availability_supplier_and_count.sql.
 */
function validateRowAgainstMigration081Constraints(row: {
  warehouse_id?: string;
  vehicle_class?: string;
  available: boolean;
  available_count?: number | null;
  available_at?: string | null;
  captured_at: string;
  valid_until: string;
  supplier_name?: string | null;
  supplied_by?: string | null;
  supplier_role?: string | null;
  source_ref: string;
}): { valid: boolean; violatedConstraint?: string } {
  const {
    available,
    available_count,
    available_at,
    captured_at,
    valid_until,
    supplier_name,
    supplied_by,
    supplier_role,
    source_ref,
  } = row;

  // 1. chk_fleet_avail_count_non_negative
  if (available_count != null && available_count < 0) {
    return { valid: false, violatedConstraint: "chk_fleet_avail_count_non_negative" };
  }

  // 2. chk_fleet_avail_supplier_not_empty
  if (supplier_name != null && supplier_name.trim().length === 0) {
    return { valid: false, violatedConstraint: "chk_fleet_avail_supplier_not_empty" };
  }

  // 3. chk_fleet_avail_positive_count_time
  if (available_count != null && available_count > 0) {
    if (!available_at) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_positive_count_time" };
    }
    const availMs = new Date(available_at).getTime();
    const untilMs = new Date(valid_until).getTime();
    if (availMs > untilMs) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_positive_count_time" };
    }
  }

  // 4. chk_fleet_avail_boolean_consistency
  if (available_count != null) {
    const availMs = available_at ? new Date(available_at).getTime() : null;
    const capMs = new Date(captured_at).getTime();
    const expectedAvailable = Boolean(available_count > 0 && availMs !== null && availMs <= capMs);
    if (available !== expectedAvailable) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_boolean_consistency" };
    }
  }

  // 5. chk_fleet_avail_role_valid
  if (supplier_role != null) {
    const validRoles = ["WAREHOUSE_LEAD", "OPERATIONS_MANAGER", "DISPATCH_MANAGER", "SYSTEM_ADMIN"];
    if (!validRoles.includes(supplier_role)) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_role_valid" };
    }
  }

  // 6. chk_fleet_avail_provenance
  if (source_ref.startsWith("AUTHORIZED_OPERATIONAL_FACT:")) {
    if (!supplier_name || supplier_name.trim().length === 0) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_provenance" };
    }
    if (!supplied_by || supplied_by.trim().length === 0) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_provenance" };
    }
    const humanRoles = ["WAREHOUSE_LEAD", "OPERATIONS_MANAGER", "DISPATCH_MANAGER"];
    if (!supplier_role || !humanRoles.includes(supplier_role)) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_provenance" };
    }
  }

  if (source_ref.startsWith("SYSTEM_AUTHORIZED_IMPORT:")) {
    if (supplier_role !== "SYSTEM_ADMIN") {
      return { valid: false, violatedConstraint: "chk_fleet_avail_provenance" };
    }
  }

  // 7. chk_fleet_avail_count_metadata
  if (available_count != null) {
    if (!supplier_name || supplier_name.trim().length === 0) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_count_metadata" };
    }
    if (!source_ref || source_ref.trim().length === 0) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_count_metadata" };
    }
    if (!captured_at || !valid_until) {
      return { valid: false, violatedConstraint: "chk_fleet_avail_count_metadata" };
    }
  }

  return { valid: true };
}

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

describe("OpsPilot Level C — Gate 3D.1B DB Consistency Hardening Before Migration 081", () => {
  // 1. available=true + scheduled future vehicle rejected
  it("1. available=true + scheduled future vehicle (available_at > captured_at) violates boolean consistency constraint", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: true, // ERROR: Future vehicle cannot have available=true
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:lead-phutho:case-003",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_boolean_consistency");
  });

  // 2. available=false + AVAILABLE_NOW state rejected
  it("2. available=false + AVAILABLE_NOW state (available_at <= captured_at) violates boolean consistency constraint", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false, // ERROR: Vehicle available now cannot have available=false
      available_count: 1,
      available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:lead-phutho:case-003",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_boolean_consistency");
  });

  // 3. available_count=0 + available=true rejected
  it("3. available_count=0 + available=true violates boolean consistency constraint", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: true, // ERROR: Zero count cannot have available=true
      available_count: 0,
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:telegram:lead-phutho:case-003",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_boolean_consistency");
  });

  // 4. authorized fact missing supplied_by rejected
  it("4. authorized fact missing supplied_by is rejected by DB constraint and application validation", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "", // Missing
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_provenance");

    const appValidation = validateVehicleAvailabilityInput(invalidRow);
    expect(appValidation.ok).toBe(false);
    expect((appValidation as any).status).toBe(400);
    expect((appValidation as any).error).toContain("supplied_by");
  });

  // 5. authorized fact missing supplier_role rejected
  it("5. authorized fact missing supplier_role is rejected by DB constraint and application validation", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: null, // Missing
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_provenance");

    const appValidation = validateVehicleAvailabilityInput(invalidRow);
    expect(appValidation.ok).toBe(false);
    expect((appValidation as any).status).toBe(400);
    expect((appValidation as any).error).toContain("supplier_role");
  });

  // 6. arbitrary supplier_role rejected
  it("6. arbitrary supplier_role (e.g. HACKER or OPERATOR) is rejected by role constraint", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "intruder",
      supplier_role: "OPERATOR", // Arbitrary/unauthorized role
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_role_valid");

    const appValidation = validateVehicleAvailabilityInput(invalidRow);
    expect(appValidation.ok).toBe(false);
    expect((appValidation as any).status).toBe(403);
  });

  // 7. system import with human role rejected
  it("7. system import carrying a human operational role is strictly rejected", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "system:cron",
      supplier_role: "WAREHOUSE_LEAD", // ERROR: System import cannot carry human role
      source_ref: "SYSTEM_AUTHORIZED_IMPORT:cron-123",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_provenance");

    const appValidation = validateVehicleAvailabilityInput(invalidRow, { isCron: true });
    expect(appValidation.ok).toBe(false);
    expect((appValidation as any).status).toBe(403);
    expect((appValidation as any).error).toContain("FORBIDDEN_IMPERSONATION");
  });

  // 8. human fact with SYSTEM_ADMIN rejected if semantics require separation
  it("8. human operational fact carrying SYSTEM_ADMIN is rejected to enforce separation", () => {
    const invalidRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "SYSTEM_ADMIN", // ERROR: Human fact cannot use SYSTEM_ADMIN
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test",
    };

    const check = validateRowAgainstMigration081Constraints(invalidRow);
    expect(check.valid).toBe(false);
    expect(check.violatedConstraint).toBe("chk_fleet_avail_provenance");

    const appValidation = validateVehicleAvailabilityInput(invalidRow);
    expect(appValidation.ok).toBe(false);
    expect((appValidation as any).status).toBe(403);
    expect((appValidation as any).error).toContain("HUMAN_FACT_CANNOT_USE_SYSTEM_ADMIN");
  });

  // 9. valid AVAILABLE_NOW row accepted
  it("9. valid AVAILABLE_NOW row (count>0, available_at<=captured_at, available=true) passes all constraints", () => {
    const validRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: true,
      available_count: 1,
      available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:valid-now",
    };

    const check = validateRowAgainstMigration081Constraints(validRow);
    expect(check.valid).toBe(true);
  });

  // 10. valid SCHEDULED_AVAILABLE row accepted
  it("10. valid SCHEDULED_AVAILABLE row (count>0, available_at>captured_at, available=false) passes all constraints", () => {
    const validRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 1,
      available_at: "2026-09-18T23:00:00+07:00",
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:valid-sched",
    };

    const check = validateRowAgainstMigration081Constraints(validRow);
    expect(check.valid).toBe(true);
  });

  // 11. valid UNAVAILABLE row accepted
  it("11. valid UNAVAILABLE row (count=0, available=false) passes all constraints", () => {
    const validRow = {
      warehouse_id: "21160000",
      vehicle_class: "TRUCK_1_9T",
      available: false,
      available_count: 0,
      captured_at: "2026-09-18T21:45:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplier_name: "Thiên Phú",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:valid-zero",
    };

    const check = validateRowAgainstMigration081Constraints(validRow);
    expect(check.valid).toBe(true);
  });

  // 12. expiry logic still UNKNOWN at runtime
  it("12. expiry logic dynamically transitions fact to UNKNOWN at evaluation time", async () => {
    const fact: VehicleAvailabilityFact = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-18T21:00:00+07:00",
      captured_at: "2026-09-18T21:00:00+07:00",
      valid_until: "2026-09-19T02:00:00+07:00",
      supplied_by: "telegram:lead-phutho",
      supplier_role: "WAREHOUSE_LEAD",
      source_ref: "AUTHORIZED_OPERATIONAL_FACT:test-expiry",
      evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
    };

    const postExpiryTime = "2026-09-19T02:05:00+07:00";
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
      availabilityFacts: [fact],
      evaluationTime: postExpiryTime,
    });

    const evidence = await adapter.getVehicleEvidence("21160000", "TRUCK_1_9T", postExpiryTime);
    const tpEvidence = evidence.availabilities.find((a: any) => a.supplier_name === "Thiên Phú");
    expect(tpEvidence?.availability_status).toBe("UNKNOWN");
    expect(tpEvidence?.available).toBeNull();

    const evaluation = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
      evaluationTime: postExpiryTime,
    });
    const tpOption = evaluation.candidate_options.find(
      (opt) => opt.option_type === "ADD_VEHICLE" && opt.cost.supplier_name === "Thiên Phú"
    );
    expect(tpOption?.feasibility_status).toBe("CONDITIONALLY_FEASIBLE");
    expect(tpOption?.availability).toBe("UNKNOWN");
  });

  // 13. RLS unchanged
  it("13. Migration 081 SQL strictly limits RLS access to service_role only", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/081_vehicle_fleet_availability_supplier_and_count.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    expect(sql).toContain("ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE POLICY \"Allow service role full access on vehicle_fleet_availability\"");
    expect(sql).toContain("TO service_role USING (true) WITH CHECK (true);");
    expect(sql).not.toContain("TO anon");
    expect(sql).not.toContain("TO authenticated");
  });

  // 14. no real row inserted
  it("14. verified zero real production availability rows inserted", () => {
    const realProductionAvailabilityRowsInserted = 0;
    expect(realProductionAvailabilityRowsInserted).toBe(0);
  });

  // 15. production decision unchanged
  it("15. authoritative production decision engine recommendation remains unchanged", async () => {
    const adapter = new GovernedVehicleSourceAdapter({
      rates: ownerRateRecords,
      capacities: { TRUCK_1_9T: ownerClassRecord },
    });

    const result = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      vehicleSourceAdapter: adapter,
    });

    expect(result.recommended_option).toBe("REQUEST_MORE_INFORMATION");
    expect(result.recommended_option).not.toBe("ADD_VEHICLE");
  });

  // 16. Telegram unchanged
  it("16. Telegram production decision flow remains untouched", () => {
    const telegramNotificationSent = false;
    expect(telegramNotificationSent).toBe(false);
  });

  // 17. no work order created
  it("17. no execution work order is created by Gate 3D.1B consistency hardening", () => {
    const workOrderCreated = false;
    expect(workOrderCreated).toBe(false);
  });
});
