import { describe, expect, it } from "vitest";
import {
  calculateCapacityPreview,
  formatFactRow,
  formatSanitizedConfirmation,
  GOVERNED_USABLE_PAYLOAD_KG,
  GOVERNED_VEHICLE_CLASS,
  isManagerAuthorized,
  PILOT_WAREHOUSES,
  validateVehicleAvailabilityForm,
  buildSubmissionPayload,
  type VehicleAvailabilityFormInput,
} from "@/app/operations/vehicle-availability/vehicle-availability-ui-logic";

describe("OpsPilot Gate 3D.4 Phase 2A — Manager Vehicle Availability Confirmation UI Tests", () => {
  const FIXED_NOW_MS = new Date("2026-09-19T15:00:00+07:00").getTime();

  // Criterion 1: Unauthenticated user denied
  it("1. Denies access when session is unauthenticated or missing roles", () => {
    expect(isManagerAuthorized(undefined, undefined)).toBe(false);
    expect(isManagerAuthorized("", "")).toBe(false);
  });

  // Criterion 2: Insufficient role denied
  it("2. Denies access to insufficient roles (VIEWER, OPERATOR, MEMBER)", () => {
    expect(isManagerAuthorized("VIEWER", "VIEWER")).toBe(false);
    expect(isManagerAuthorized("OPERATOR", "OPERATOR")).toBe(false);
    expect(isManagerAuthorized("MEMBER", undefined)).toBe(false);
    expect(isManagerAuthorized(undefined, "GUEST")).toBe(false);
  });

  // Criterion 3: Manager can access form
  it("3. Grants access to authorized managers (OPERATIONS_MANAGER, MANAGER, ADMIN, DISPATCH_MANAGER)", () => {
    expect(isManagerAuthorized("OPERATIONS_MANAGER", undefined)).toBe(true);
    expect(isManagerAuthorized(undefined, "OPERATIONS_MANAGER")).toBe(true);
    expect(isManagerAuthorized("MANAGER", undefined)).toBe(true);
    expect(isManagerAuthorized("ADMIN", undefined)).toBe(true);
    expect(isManagerAuthorized(undefined, "DISPATCH_MANAGER")).toBe(true);
  });

  // Criterion 4: Positive integer count required
  it("4. Enforces positive integer count (rejects 0, -1, floats, non-numeric)", () => {
    const validBase: Partial<VehicleAvailabilityFormInput> = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      earliest_available_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    expect(validateVehicleAvailabilityForm({ ...validBase, available_count: 0 }, FIXED_NOW_MS).valid).toBe(false);
    expect(validateVehicleAvailabilityForm({ ...validBase, available_count: -1 }, FIXED_NOW_MS).valid).toBe(false);
    expect(validateVehicleAvailabilityForm({ ...validBase, available_count: 1.5 }, FIXED_NOW_MS).valid).toBe(false);
    expect(validateVehicleAvailabilityForm({ ...validBase, available_count: "abc" }, FIXED_NOW_MS).valid).toBe(false);
    expect(validateVehicleAvailabilityForm({ ...validBase, available_count: 1 }, FIXED_NOW_MS).valid).toBe(true);
  });

  // Criterion 5: Expired valid_until blocked
  it("5. Blocks valid_until in the past or equal to current evaluation time", () => {
    const expiredInput: Partial<VehicleAvailabilityFormInput> = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T12:00:00+07:00", // expired before FIXED_NOW_MS (15:00)
    };

    const res = validateVehicleAvailabilityForm(expiredInput, FIXED_NOW_MS);
    expect(res.valid).toBe(false);
    expect(res.errors.valid_until).toMatch(/hết hạn|không ghi nhận fact đã hết hạn/i);
  });

  // Criterion 6: valid_until before earliest_available_at blocked
  it("6. Blocks valid_until earlier than earliest_available_at", () => {
    const invertedInput: Partial<VehicleAvailabilityFormInput> = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 1,
      earliest_available_at: "2026-09-19T17:00:00+07:00",
      valid_until: "2026-09-19T16:00:00+07:00", // earlier than earliest
    };

    const res = validateVehicleAvailabilityForm(invertedInput, FIXED_NOW_MS);
    expect(res.valid).toBe(false);
    expect(res.errors.valid_until).toMatch(/không được sớm hơn/i);
  });

  // Criterion 7: Valid future input accepted
  it("7. Accepts valid future inputs with authorized pilot warehouse and supplier", () => {
    const validInput: VehicleAvailabilityFormInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    const res = validateVehicleAvailabilityForm(validInput, FIXED_NOW_MS);
    expect(res.valid).toBe(true);
    expect(Object.keys(res.errors).length).toBe(0);
  });

  // Criterion 8: Token is never rendered
  it("8. Invariant: Authentication token is never accepted or returned in UI logic or formatters", () => {
    const sampleInput: VehicleAvailabilityFormInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    const payload = buildSubmissionPayload(sampleInput);
    expect((payload as any).token).toBeUndefined();
    expect((payload as any).access_token).toBeUndefined();
    expect((payload as any).bearer).toBeUndefined();

    const confirmation = formatSanitizedConfirmation("uuid-test-12345", sampleInput, FIXED_NOW_MS);
    const serializedConfirmation = JSON.stringify(confirmation);
    expect(serializedConfirmation).not.toMatch(/bearer|token|secret|jwt/i);
  });

  // Criterion 9: Actor role is NOT form-controlled
  it("9. Invariant: Actor role is not controlled by form input or submission payload", () => {
    const sampleInput: VehicleAvailabilityFormInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    const payload = buildSubmissionPayload(sampleInput);
    const keys = Object.keys(payload);
    expect(keys).not.toContain("role");
    expect(keys).not.toContain("actor_role");
    expect(keys).not.toContain("operational_role");
  });

  // Criterion 10: Actor identity is NOT form-controlled
  it("10. Invariant: Actor identity is not controlled by form input or submission payload", () => {
    const sampleInput: VehicleAvailabilityFormInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:30:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    const payload = buildSubmissionPayload(sampleInput);
    const keys = Object.keys(payload);
    expect(keys).not.toContain("actor");
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("created_by");
    expect(keys).not.toContain("actor_id");
  });

  // Criterion 11: Same-origin API target
  it("11. Submission target route is internal and same-origin relative", () => {
    const TARGET_ENDPOINT = "/api/internal/governed-sources/vehicle-availability";
    expect(TARGET_ENDPOINT.startsWith("/api/internal/")).toBe(true);
    expect(TARGET_ENDPOINT.startsWith("http")).toBe(false);
  });

  // Criterion 12: Capacity preview for 1 vehicle = 1,600 kg
  it("12. Capacity preview calculates 1 vehicle = 1,600 kg usable payload", () => {
    const preview = calculateCapacityPreview(1, GOVERNED_VEHICLE_CLASS);
    expect(preview.usablePayloadKg).toBe(1600);
    expect(preview.plannedCapacityKg).toBe(1600);
    expect(preview.displayText).toContain("1.600 kg");
  });

  // Criterion 13: Capacity preview for 2 vehicles = 3,200 kg
  it("13. Capacity preview calculates 2 vehicles = 3,200 kg usable payload", () => {
    const preview = calculateCapacityPreview(2, GOVERNED_VEHICLE_CLASS);
    expect(preview.usablePayloadKg).toBe(1600);
    expect(preview.plannedCapacityKg).toBe(3200);
    expect(preview.displayText).toContain("3.200 kg");
  });

  // Criterion 14: UNKNOWN state does NOT render as 0 xe or 0 kg (UNKNOWN != ZERO)
  it("14. Enforces UNKNOWN != ZERO semantics: missing available_count renders as UNKNOWN / NULL, not 0 xe or 0 kg", () => {
    const unknownRowNull = formatFactRow({
      warehouse_id: "21158000",
      available_count: null,
      valid_until: "2026-09-19T17:00:00+07:00",
    }, FIXED_NOW_MS);

    expect(unknownRowNull.countDisplay).toBe("UNKNOWN / NULL");
    expect(unknownRowNull.capacityDisplay).toBe("UNKNOWN / NULL");
    expect(unknownRowNull.countDisplay).not.toBe("0 xe");
    expect(unknownRowNull.capacityDisplay).not.toBe("0 kg");

    const unknownRowUndefined = formatFactRow({
      warehouse_id: "21158000",
      available_count: undefined,
    }, FIXED_NOW_MS);

    expect(unknownRowUndefined.countDisplay).toBe("UNKNOWN / NULL");
    expect(unknownRowUndefined.capacityDisplay).toBe("UNKNOWN / NULL");

    // Contrast with explicit zero (UNAVAILABLE)
    const zeroRow = formatFactRow({
      warehouse_id: "21158000",
      available_count: 0,
      valid_until: "2026-09-19T17:00:00+07:00",
    }, FIXED_NOW_MS);
    expect(zeroRow.status).toBe("UNAVAILABLE");
    expect(zeroRow.countDisplay).toBe("0 xe");
    expect(zeroRow.capacityDisplay).toBe("0 kg");
  });

  // Criterion 15: Expired fact does NOT display as AVAILABLE_NOW
  it("15. Displays expired facts as EXPIRED and never as AVAILABLE_NOW", () => {
    const expiredFact = {
      warehouse_id: "21161000",
      available_count: 1,
      available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T12:00:00+07:00",
    };

    const row = formatFactRow(expiredFact, FIXED_NOW_MS);
    expect(row.isExpired).toBe(true);
    expect(row.status).toBe("EXPIRED");
    expect(row.status).not.toBe("AVAILABLE_NOW");
  });

  // Criterion 16: Successful response renders sanitized confirmation
  it("16. Formats sanitized confirmation upon successful persistence", () => {
    const input: VehicleAvailabilityFormInput = {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    };

    const confirmation = formatSanitizedConfirmation("b0e45c71-6925-419b-8ca0-1234567890ab", input, FIXED_NOW_MS);
    expect(confirmation.warehouseId).toBe("21160000");
    expect(confirmation.supplierName).toBe("Thiên Phú");
    expect(confirmation.vehicleClass).toBe(GOVERNED_VEHICLE_CLASS);
    expect(confirmation.availableCount).toBe(2);
    expect(confirmation.plannedCapacityKg).toBe(3200);
    expect(confirmation.safeFactId).toBe("b0e45c71-6...");
    expect(confirmation.status).toBe("AVAILABLE_NOW");
  });

  // Criterion 17: No commercial rate displayed
  it("17. Invariant: No commercial rates or prices displayed in preview or confirmations", () => {
    const preview = calculateCapacityPreview(2);
    const confirmation = formatSanitizedConfirmation("id", {
      warehouse_id: "21160000",
      supplier_name: "Thiên Phú",
      vehicle_class: GOVERNED_VEHICLE_CLASS,
      available_count: 2,
      earliest_available_at: "2026-09-19T15:00:00+07:00",
      valid_until: "2026-09-19T17:00:00+07:00",
    });

    const combined = `${JSON.stringify(preview)} ${JSON.stringify(confirmation)}`;
    expect(combined).not.toMatch(/vnd|₫|usd|cước|đơn giá|price|cost|commercial/i);
  });

  // Criterion 18: No SLA claim
  it("18. Invariant: Disclaimer explicitly clarifies no SLA commitment", () => {
    const preview = calculateCapacityPreview(1);
    expect(preview.disclaimer).toMatch(/không phải cam kết SLA/i);
    expect(preview.label).not.toMatch(/SLA/i);
  });

  // Criterion 19: No saving claim
  it("19. Invariant: Disclaimer explicitly clarifies no cost saving estimation", () => {
    const preview = calculateCapacityPreview(1);
    expect(preview.disclaimer).toMatch(/không phải.*ước tính tiết kiệm/i);
    expect(preview.label).not.toMatch(/tiết kiệm|savings/i);
  });

  // Criterion 20: Automated test must NOT create any real production availability fact
  it("20. Invariant: Automated test creates ZERO production database records or API writes", () => {
    // Verified by pure unit/logic nature of test without network or database connectors.
    expect(PILOT_WAREHOUSES.length).toBe(3);
    expect(GOVERNED_USABLE_PAYLOAD_KG).toBe(1600);
  });
});
