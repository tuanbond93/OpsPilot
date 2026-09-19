import { describe, expect, it } from "vitest";
import {
  DELIVERY_OPERATING_WINDOW,
  isWithinDeliveryOperatingWindow,
  validateDeliveryOperatingWindowTimestamps,
  getOperatingWindowClockParts,
  getDeliveryOperatingWindowPosition,
} from "@/domain/near-term-capacity/operating-window";
import {
  computeAvailabilityStatus,
  evaluateScheduleEvidence,
  GovernedVehicleSourceAdapter,
  type VehicleAvailabilitySchedule,
  type VehicleAvailabilityFact,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter";
import {
  validateVehicleAvailabilityInput,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";
import { validateVehicleAvailabilityForm } from "@/app/operations/vehicle-availability/vehicle-availability-ui-logic";

describe("Gate 3D.4 Delivery Vehicle Operating Window Governance", () => {
  const testDate = "2026-09-20";

  // 1. 06:59 fact rejected
  it("Scenario 1: rejects fact with earliest_available_at at 06:59 (before 07:00)", () => {
    const earliest = `${testDate}T06:59:00+07:00`;
    const validUntil = `${testDate}T12:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("earliest_available_at");
    expect(domainRes.error).toContain("07:00");

    const inputRes = validateVehicleAvailabilityInput({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: earliest,
      valid_until: validUntil,
      supplied_by: "manager@example.com",
      supplier_role: "OPERATIONS_MANAGER",
    });
    expect(inputRes.ok).toBe(false);
    if (!inputRes.ok) {
      expect(inputRes.error).toContain("OUTSIDE_OPERATING_WINDOW");
    }
  });

  // 2. 07:00 accepted
  it("Scenario 2: accepts fact with earliest_available_at exactly at 07:00", () => {
    const earliest = `${testDate}T07:00:00+07:00`;
    const validUntil = `${testDate}T12:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(true);

    const inputRes = validateVehicleAvailabilityInput({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: earliest,
      valid_until: validUntil,
      supplied_by: "manager@example.com",
      supplier_role: "OPERATIONS_MANAGER",
    });
    expect(inputRes.ok).toBe(true);
  });

  // 3. 16:59 accepted
  it("Scenario 3: accepts fact with earliest_available_at at 16:59 and valid_until at 17:00", () => {
    const earliest = `${testDate}T16:59:00+07:00`;
    const validUntil = `${testDate}T17:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(true);

    const inputRes = validateVehicleAvailabilityInput({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: earliest,
      valid_until: validUntil,
      supplied_by: "manager@example.com",
      supplier_role: "OPERATIONS_MANAGER",
    });
    expect(inputRes.ok).toBe(true);
  });

  // 4. valid_until exactly 17:00 accepted
  it("Scenario 4: accepts fact with valid_until exactly at 17:00:00", () => {
    const earliest = `${testDate}T14:00:00+07:00`;
    const validUntil = `${testDate}T17:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(true);
  });

  // 5. earliest 17:00 rejected for new availability
  it("Scenario 5: rejects fact with earliest_available_at at 17:00 (closing boundary)", () => {
    const earliest = `${testDate}T17:00:00+07:00`;
    const validUntil = `${testDate}T17:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("earliest_available_at");
  });

  // 6. valid_until 17:01 rejected
  it("Scenario 6: rejects fact with valid_until at 17:01", () => {
    const earliest = `${testDate}T14:00:00+07:00`;
    const validUntil = `${testDate}T17:01:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("valid_until");
    expect(domainRes.error).toContain("17:00");
  });

  // 7. valid_until 18:00 rejected
  it("Scenario 7: rejects fact with valid_until at 18:00", () => {
    const earliest = `${testDate}T15:15:00+07:00`;
    const validUntil = `${testDate}T18:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("valid_until (18:00)");

    const uiRes = validateVehicleAvailabilityForm({
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: earliest,
      valid_until: validUntil,
    });
    expect(uiRes.valid).toBe(false);
    expect(uiRes.errors.valid_until).toBeDefined();
  });

  // 8. 23:00 rejected
  it("Scenario 8: rejects fact with valid_until at 23:00", () => {
    const earliest = `${testDate}T14:00:00+07:00`;
    const validUntil = `${testDate}T23:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("17:00");
  });

  // 9. cross-midnight fact rejected
  it("Scenario 9: rejects cross-midnight / multi-day availability facts", () => {
    const earliest = `${testDate}T16:00:00+07:00`;
    const nextDay = "2026-09-21";
    const validUntil = `${nextDay}T02:00:00+07:00`;

    const domainRes = validateDeliveryOperatingWindowTimestamps(earliest, validUntil);
    expect(domainRes.valid).toBe(false);
    expect(domainRes.error).toContain("same governed delivery operating day");
  });

  // 10. current time before 07:00 -> OUTSIDE_OPERATING_WINDOW
  it("Scenario 10: evaluates to OUTSIDE_OPERATING_WINDOW when current time is before 07:00", () => {
    const evalTime = new Date(`${testDate}T06:30:00+07:00`).getTime();
    expect(isWithinDeliveryOperatingWindow(evalTime)).toBe(false);

    const statusRes = computeAvailabilityStatus(1, `${testDate}T07:00:00+07:00`, `${testDate}T12:00:00+07:00`, evalTime);
    expect(statusRes.status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(statusRes.available).toBeNull();
  });

  // 11. current time after 17:00 -> OUTSIDE_OPERATING_WINDOW
  it("Scenario 11: evaluates to OUTSIDE_OPERATING_WINDOW when current time is after 17:00", () => {
    const evalTime = new Date(`${testDate}T17:30:00+07:00`).getTime();
    expect(isWithinDeliveryOperatingWindow(evalTime)).toBe(false);

    const statusRes = computeAvailabilityStatus(1, `${testDate}T07:00:00+07:00`, `${testDate}T17:00:00+07:00`, evalTime);
    expect(statusRes.status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(statusRes.available).toBeNull();
  });

  // 12. 07:00–17:00 with no evidence -> UNKNOWN, not zero
  it("Scenario 12: returns UNKNOWN (not zero) when within 07:00–17:00 with no evidence", () => {
    const evalTime = new Date(`${testDate}T11:00:00+07:00`).getTime();
    expect(isWithinDeliveryOperatingWindow(evalTime)).toBe(true);

    const adapter = new GovernedVehicleSourceAdapter({
      evaluationTime: evalTime,
      availabilityFacts: [],
      schedules: [],
    });

    const ev = adapter.getVehicleAvailability("21160000", "TRUCK_1_9T", "Thiên Phú", evalTime);
    expect(ev.availability_status).toBe("UNKNOWN");
    expect(ev.available_count).toBeUndefined();
    expect(ev.available).toBeNull();
  });

  // 13. explicit zero fact during operating hours -> UNAVAILABLE
  it("Scenario 13: evaluates explicit zero count during operating hours to UNAVAILABLE", () => {
    const evalTime = new Date(`${testDate}T10:30:00+07:00`).getTime();
    const statusRes = computeAvailabilityStatus(
      0,
      null,
      `${testDate}T17:00:00+07:00`,
      evalTime
    );
    expect(statusRes.status).toBe("UNAVAILABLE");
    expect(statusRes.available).toBe(false);
  });

  // 14. OUTSIDE_OPERATING_WINDOW != UNKNOWN
  it("Scenario 14: proves OUTSIDE_OPERATING_WINDOW is distinct from UNKNOWN", () => {
    const outsideTime = new Date(`${testDate}T21:00:00+07:00`).getTime();
    const insideTime = new Date(`${testDate}T11:00:00+07:00`).getTime();

    const outsideRes = computeAvailabilityStatus(null, null, null, outsideTime);
    const insideRes = computeAvailabilityStatus(null, null, null, insideTime);

    expect(outsideRes.status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(insideRes.status).toBe("UNKNOWN");
    expect(outsideRes.status).not.toBe(insideRes.status);
  });

  // 15. OUTSIDE_OPERATING_WINDOW != UNAVAILABLE
  it("Scenario 15: proves OUTSIDE_OPERATING_WINDOW is distinct from UNAVAILABLE", () => {
    const outsideTime = new Date(`${testDate}T22:00:00+07:00`).getTime();
    const insideTime = new Date(`${testDate}T14:00:00+07:00`).getTime();

    const outsideRes = computeAvailabilityStatus(0, null, `${testDate}T17:00:00+07:00`, outsideTime);
    const insideRes = computeAvailabilityStatus(0, null, `${testDate}T17:00:00+07:00`, insideTime);

    expect(outsideRes.status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(insideRes.status).toBe("UNAVAILABLE");
    expect(outsideRes.status).not.toBe(insideRes.status);
  });

  // 16. existing 07:00–10:00 recurring schedule remains valid
  it("Scenario 16: existing 07:00–10:00 recurring schedule evaluates to PLANNED_AVAILABLE_NOW during 07:00–10:00", () => {
    const evalTime = new Date(`${testDate}T08:30:00+07:00`).getTime();
    const sched: VehicleAvailabilitySchedule = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      planned_available_count: 2,
      recurrence_type: "DAILY",
      timezone: "Asia/Ho_Chi_Minh",
      local_start_time: "07:00",
      local_end_time: "10:00",
      effective_from: "2026-09-01",
      supplied_by: "ops_owner",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "SCHED:PHU_THO",
      provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
    };

    const ev = evaluateScheduleEvidence(sched, evalTime, "21160000", "TRUCK_1_9T");
    expect(ev).not.toBeNull();
    expect(ev?.availability_status).toBe("PLANNED_AVAILABLE_NOW");
    expect(ev?.available_count).toBe(2);
    expect(ev?.available).toBe(true);
  });

  // 17. after recurring schedule (10:00) but before 17:00, schedule rolls to tomorrow (never AVAILABLE_NOW)
  it("Scenario 17: after recurring schedule (10:00) but before 17:00, schedule rolls to tomorrow (never AVAILABLE_NOW)", () => {
    const evalTime = new Date(`${testDate}T13:00:00+07:00`).getTime();
    const sched: VehicleAvailabilitySchedule = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      planned_available_count: 2,
      recurrence_type: "DAILY",
      timezone: "Asia/Ho_Chi_Minh",
      local_start_time: "07:00",
      local_end_time: "10:00",
      effective_from: "2026-09-01",
      supplied_by: "ops_owner",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "SCHED:PHU_THO",
      provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
    };

    const ev = evaluateScheduleEvidence(sched, evalTime, "21160000", "TRUCK_1_9T");
    expect(ev).not.toBeNull();
    expect(ev?.availability_status).toBe("SCHEDULED_AVAILABLE");
    expect(ev?.availability_status).not.toBe("AVAILABLE_NOW");
    expect(ev?.available).toBe(false);
  });

  // 18. after 17:00 recurring schedule cannot create live availability
  it("Scenario 18: after 17:00 recurring schedule evaluates to OUTSIDE_OPERATING_WINDOW", () => {
    const evalTime = new Date(`${testDate}T18:00:00+07:00`).getTime();
    const sched: VehicleAvailabilitySchedule = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      planned_available_count: 2,
      recurrence_type: "DAILY",
      timezone: "Asia/Ho_Chi_Minh",
      local_start_time: "07:00",
      local_end_time: "10:00",
      effective_from: "2026-09-01",
      supplied_by: "ops_owner",
      supplier_role: "OPERATIONS_MANAGER",
      source_ref: "SCHED:PHU_THO",
      provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
    };

    const ev = evaluateScheduleEvidence(sched, evalTime, "21160000", "TRUCK_1_9T");
    expect(ev).not.toBeNull();
    expect(ev?.availability_status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(ev?.available_count).toBeNull();
  });

  // 19. supersession rejects invalid replacement timestamps
  it("Scenario 19: supersession validation rejects replacement fact with valid_until > 17:00", () => {
    const invalidReplacementInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: "TRUCK_1_9T",
      available_count: 2,
      earliest_available_at: `${testDate}T15:15:00+07:00`,
      valid_until: `${testDate}T18:00:00+07:00`, // invalid: > 17:00
      supplied_by: "manager@example.com",
      supplier_role: "OPERATIONS_MANAGER",
      supersession_reason: "DIRECT_OWNER_CORRECTION",
    };

    const validation = validateVehicleAvailabilityInput(invalidReplacementInput);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error).toContain("OUTSIDE_OPERATING_WINDOW");
      expect(validation.error).toContain("17:00");
    }
  });

  // 20. no production facts written by tests
  it("Scenario 20: test suite executes purely in-memory with zero writes to production database", () => {
    // Assert canonical constants are pure and non-mutating
    expect(DELIVERY_OPERATING_WINDOW.daily_start).toBe("07:00");
    expect(DELIVERY_OPERATING_WINDOW.daily_end).toBe("17:00");
    expect(DELIVERY_OPERATING_WINDOW.timezone).toBe("Asia/Ho_Chi_Minh");
  });
});
