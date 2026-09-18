import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuthorizedOperationalRole,
  VehicleAvailabilityFact,
} from "./vehicle-source-adapter";

export const ALLOWED_AVAILABILITY_ROLES: ReadonlySet<string> = new Set([
  "WAREHOUSE_LEAD",
  "DISPATCH_MANAGER",
  "OPERATIONS_MANAGER",
  "LEAD",
  "MANAGER",
  "ADMIN",
]);

export function isActorAuthorizedForAvailability(role: string | null | undefined): boolean {
  if (!role) return false;
  return ALLOWED_AVAILABILITY_ROLES.has(role.trim().toUpperCase());
}

export interface FactSubmissionInput {
  warehouse_id: string;
  supplier_name: string;
  vehicle_class: string;
  available_count: number;
  earliest_available_at?: string | null;
  captured_at?: string | null;
  valid_until: string;
  supplied_by: string;
  supplier_role: string;
  interaction_id?: string | null;
  source_ref?: string | null;
}

export function validateVehicleAvailabilityInput(
  input: any,
  now: number = Date.now()
): { ok: true; fact: VehicleAvailabilityFact } | { ok: false; error: string; status: number } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "INVALID_BODY: JSON object required", status: 400 };
  }

  const warehouseId = typeof input.warehouse_id === "string" ? input.warehouse_id.trim() : "";
  if (!warehouseId) {
    return { ok: false, error: "MISSING_FIELD: warehouse_id is required", status: 400 };
  }

  const supplierName = typeof input.supplier_name === "string" ? input.supplier_name.trim() : "";
  if (!supplierName) {
    return { ok: false, error: "MISSING_FIELD: supplier_name is required", status: 400 };
  }

  const vehicleClass = typeof input.vehicle_class === "string" ? input.vehicle_class.trim() : "TRUCK_1_9T";
  if (!vehicleClass) {
    return { ok: false, error: "MISSING_FIELD: vehicle_class is required", status: 400 };
  }

  const count = Number(input.available_count);
  if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
    return { ok: false, error: "INVALID_FIELD: available_count must be an integer >= 0", status: 400 };
  }

  const suppliedBy = typeof input.supplied_by === "string" ? input.supplied_by.trim() : "";
  if (!suppliedBy) {
    return { ok: false, error: "MISSING_FIELD: supplied_by is required", status: 400 };
  }

  const supplierRole = typeof input.supplier_role === "string" ? input.supplier_role.trim().toUpperCase() : "";
  if (!isActorAuthorizedForAvailability(supplierRole)) {
    return {
      ok: false,
      error: `PERMISSION_DENIED: Role '${supplierRole || "UNKNOWN"}' is not authorized. Allowed roles: Warehouse Lead (LEAD), Dispatch/Operations Manager (MANAGER/ADMIN).`,
      status: 403,
    };
  }

  const capturedAt = input.captured_at ? new Date(input.captured_at).toISOString() : new Date(now).toISOString();
  const capturedAtMs = new Date(capturedAt).getTime();
  if (isNaN(capturedAtMs)) {
    return { ok: false, error: "INVALID_FIELD: captured_at must be a valid ISO date", status: 400 };
  }

  if (!input.valid_until) {
    return {
      ok: false,
      error: "MISSING_FIELD: valid_until is required; TTL must not be silently invented.",
      status: 400,
    };
  }

  const validUntil = new Date(input.valid_until).toISOString();
  const validUntilMs = new Date(validUntil).getTime();
  if (isNaN(validUntilMs)) {
    return { ok: false, error: "INVALID_FIELD: valid_until must be a valid ISO date", status: 400 };
  }

  if (validUntilMs <= capturedAtMs) {
    return {
      ok: false,
      error: "INVALID_TTL: valid_until must be strictly greater than captured_at",
      status: 400,
    };
  }

  let earliestAvailableAt: string | null = null;
  if (input.earliest_available_at) {
    const earliestMs = new Date(input.earliest_available_at).getTime();
    if (!isNaN(earliestMs)) {
      earliestAvailableAt = new Date(earliestMs).toISOString();
    }
  }

  const interactionId = typeof input.interaction_id === "string" && input.interaction_id.trim()
    ? input.interaction_id.trim()
    : `${warehouseId}-${Date.now()}`;

  const sourceRef = input.source_ref && typeof input.source_ref === "string"
    ? input.source_ref.trim()
    : `AUTHORIZED_OPERATIONAL_FACT:${interactionId}`;

  const fact: VehicleAvailabilityFact = {
    warehouse_id: warehouseId,
    supplier_name: supplierName,
    vehicle_class: vehicleClass,
    available_count: count,
    earliest_available_at: earliestAvailableAt,
    captured_at: capturedAt,
    valid_until: validUntil,
    supplied_by: suppliedBy,
    supplier_role: supplierRole as AuthorizedOperationalRole,
    source_ref: sourceRef,
    evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
  };

  return { ok: true, fact };
}

export async function persistVehicleAvailabilityFact(
  db: SupabaseClient,
  fact: VehicleAvailabilityFact
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const isAvailable = fact.available_count > 0;
    const { data, error } = await db
      .from("vehicle_fleet_availability")
      .insert({
        warehouse_id: fact.warehouse_id,
        supplier_name: fact.supplier_name,
        vehicle_class: fact.vehicle_class,
        available: isAvailable,
        available_count: fact.available_count,
        available_at: fact.earliest_available_at || fact.captured_at,
        captured_at: fact.captured_at,
        valid_until: fact.valid_until,
        source_ref: fact.source_ref,
      })
      .select("id")
      .single();

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true, id: data?.id || "persisted" };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
