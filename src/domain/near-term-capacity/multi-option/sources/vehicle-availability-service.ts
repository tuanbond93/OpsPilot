import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuthorizedOperationalRole,
  VehicleAvailabilityFact,
} from "./vehicle-source-adapter";

export const ALLOWED_AVAILABILITY_ROLES: ReadonlySet<string> = new Set([
  "WAREHOUSE_LEAD",
  "DISPATCH_MANAGER",
  "OPERATIONS_MANAGER",
  "SYSTEM_ADMIN",
  "LEAD",
  "MANAGER",
  "ADMIN",
]);

export function isActorAuthorizedForAvailability(role: string | null | undefined): boolean {
  if (!role) return false;
  return ALLOWED_AVAILABILITY_ROLES.has(role.trim().toUpperCase());
}

export interface AuthContext {
  isCron?: boolean;
  identity?: {
    userId: string;
    actor: string;
    role: string;
    appMetadata?: Record<string, unknown> | null;
    userMetadata?: Record<string, unknown> | null;
  } | null;
}

export interface FactSubmissionInput {
  warehouse_id: string;
  supplier_name: string;
  vehicle_class: string;
  available_count: number;
  earliest_available_at?: string | null;
  captured_at?: string | null;
  valid_until: string;
  supplied_by?: string;
  supplier_role?: string;
  interaction_id?: string | null;
  source_ref?: string | null;
}

export function validateVehicleAvailabilityInput(
  input: any,
  authContext?: AuthContext,
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
    return { ok: false, error: "MISSING_FIELD: supplier_name is required and must not be empty", status: 400 };
  }

  const vehicleClass = typeof input.vehicle_class === "string" ? input.vehicle_class.trim() : "TRUCK_1_9T";
  if (!vehicleClass) {
    return { ok: false, error: "MISSING_FIELD: vehicle_class is required", status: 400 };
  }

  // Issue 3 & 4: Actor Provenance & Authorization Hardening
  let finalSuppliedBy = "";
  let finalSupplierRole: AuthorizedOperationalRole = "OPERATIONS_MANAGER";
  let evidenceStatus: "AUTHORIZED_OPERATIONAL_FACT" | "SYSTEM_AUTHORIZED_IMPORT" = "AUTHORIZED_OPERATIONAL_FACT";

  if (authContext?.isCron) {
    // CRON_SECRET calls must NOT carry human operational roles
    const claimedRole = typeof input.supplier_role === "string" ? input.supplier_role.trim().toUpperCase() : "";
    if (claimedRole && claimedRole !== "SYSTEM_ADMIN") {
      return {
        ok: false,
        error: `FORBIDDEN_IMPERSONATION: CRON_SECRET service call cannot carry human operational role '${claimedRole}'. Must use SYSTEM_ADMIN.`,
        status: 403,
      };
    }
    const claimedActor = typeof input.supplied_by === "string" ? input.supplied_by.trim() : "";
    if (claimedActor.startsWith("telegram:")) {
      return {
        ok: false,
        error: "FORBIDDEN_IMPERSONATION: CRON_SECRET service call cannot masquerade as human Telegram actor. Use authenticated human session.",
        status: 403,
      };
    }

    finalSuppliedBy = claimedActor || "system:cron";
    finalSupplierRole = "SYSTEM_ADMIN";
    evidenceStatus = "SYSTEM_AUTHORIZED_IMPORT";
  } else if (authContext?.identity) {
    const principal = authContext.identity;
    const roleMetadata = (
      principal.userMetadata?.opspilot_operational_role ||
      principal.appMetadata?.opspilot_operational_role ||
      principal.userMetadata?.warehouse_role ||
      principal.role
    ) as string;

    const normalizedMeta = typeof roleMetadata === "string" ? roleMetadata.trim().toUpperCase() : "";

    let derivedRole: AuthorizedOperationalRole = "OPERATIONS_MANAGER";
    if (normalizedMeta === "ADMIN") {
      derivedRole = "OPERATIONS_MANAGER";
    } else if (normalizedMeta === "MANAGER" || normalizedMeta === "OPERATIONS_MANAGER") {
      derivedRole = "OPERATIONS_MANAGER";
    } else if (normalizedMeta === "DISPATCH_MANAGER") {
      derivedRole = "DISPATCH_MANAGER";
    } else if (normalizedMeta === "WAREHOUSE_LEAD" || normalizedMeta === "LEAD") {
      derivedRole = "WAREHOUSE_LEAD";
    } else {
      return {
        ok: false,
        error: `PERMISSION_DENIED: Role '${principal.role}' is not authorized to submit vehicle availability facts.`,
        status: 403,
      };
    }

    // Body cannot claim SYSTEM_ADMIN for a human operational fact
    const bodyRole = typeof input.supplier_role === "string" ? input.supplier_role.trim().toUpperCase() : "";
    if (bodyRole === "SYSTEM_ADMIN") {
      return {
        ok: false,
        error: "HUMAN_FACT_CANNOT_USE_SYSTEM_ADMIN: Human operational facts cannot carry role SYSTEM_ADMIN. Allowed human operational roles: WAREHOUSE_LEAD, OPERATIONS_MANAGER, DISPATCH_MANAGER.",
        status: 403,
      };
    }
    if (bodyRole) {
      const isEquivalent =
        bodyRole === derivedRole ||
        (bodyRole === "LEAD" && derivedRole === "WAREHOUSE_LEAD") ||
        (bodyRole === "MANAGER" && derivedRole === "OPERATIONS_MANAGER");

      if (!isEquivalent) {
        return {
          ok: false,
          error: `ROLE_MISMATCH: Caller body claimed '${bodyRole}' but authenticated principal is mapped to '${derivedRole}'. Body role self-promotion is blocked.`,
          status: 403,
        };
      }
    }

    finalSuppliedBy = principal.actor || `user:${principal.userId}`;
    finalSupplierRole = derivedRole;
    evidenceStatus = "AUTHORIZED_OPERATIONAL_FACT";
  } else {
    // Direct invocation without authContext (e.g. unit tests and internal service helpers)
    const suppliedBy = typeof input.supplied_by === "string" ? input.supplied_by.trim() : "";
    if (!suppliedBy) {
      return { ok: false, error: "MISSING_FIELD: supplied_by is required", status: 400 };
    }

    const supplierRole = typeof input.supplier_role === "string" ? input.supplier_role.trim().toUpperCase() : "";
    if (!supplierRole) {
      return { ok: false, error: "MISSING_FIELD: supplier_role is required", status: 400 };
    }
    if (!isActorAuthorizedForAvailability(supplierRole)) {
      return {
        ok: false,
        error: `PERMISSION_DENIED: Role '${supplierRole}' is not authorized. Allowed roles: WAREHOUSE_LEAD, OPERATIONS_MANAGER, DISPATCH_MANAGER, SYSTEM_ADMIN.`,
        status: 403,
      };
    }

    evidenceStatus = (
      input.evidence_status === "SYSTEM_AUTHORIZED_IMPORT" ||
      (typeof input.source_ref === "string" && input.source_ref.startsWith("SYSTEM_AUTHORIZED_IMPORT"))
    )
      ? "SYSTEM_AUTHORIZED_IMPORT"
      : "AUTHORIZED_OPERATIONAL_FACT";

    if (evidenceStatus === "AUTHORIZED_OPERATIONAL_FACT" && (supplierRole === "SYSTEM_ADMIN" || supplierRole === "ADMIN")) {
      return {
        ok: false,
        error: "HUMAN_FACT_CANNOT_USE_SYSTEM_ADMIN: Human operational facts cannot carry role SYSTEM_ADMIN. Allowed roles: WAREHOUSE_LEAD, OPERATIONS_MANAGER, DISPATCH_MANAGER.",
        status: 403,
      };
    }

    if (evidenceStatus === "SYSTEM_AUTHORIZED_IMPORT" && supplierRole !== "SYSTEM_ADMIN") {
      return {
        ok: false,
        error: "SYSTEM_IMPORT_CANNOT_USE_HUMAN_ROLE: System imports must use role SYSTEM_ADMIN and cannot carry human operational roles.",
        status: 403,
      };
    }

    finalSuppliedBy = suppliedBy;
    finalSupplierRole = (
      supplierRole === "LEAD"
        ? "WAREHOUSE_LEAD"
        : supplierRole === "MANAGER"
        ? "OPERATIONS_MANAGER"
        : supplierRole
    ) as AuthorizedOperationalRole;
  }

  const count = Number(input.available_count);
  if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
    return { ok: false, error: "INVALID_FIELD: available_count must be an integer >= 0", status: 400 };
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

  if (validUntilMs <= capturedAtMs || validUntilMs <= now) {
    return {
      ok: false,
      error: "SKIPPED_EXPIRED_BEFORE_WRITE: valid_until must be strictly greater than captured_at and current write time",
      status: 400,
    };
  }

  // Issue 2: Positive availability count requires earliest_available_at <= valid_until
  let earliestAvailableAt: string | null = null;
  if (count > 0) {
    if (!input.earliest_available_at) {
      return {
        ok: false,
        error: "MISSING_FIELD: earliest_available_at is required when available_count > 0. Ambiguous positive availability without timing is rejected.",
        status: 400,
      };
    }
    const earliestMs = new Date(input.earliest_available_at).getTime();
    if (isNaN(earliestMs)) {
      return {
        ok: false,
        error: "INVALID_FIELD: earliest_available_at must be a valid ISO date",
        status: 400,
      };
    }
    if (earliestMs > validUntilMs) {
      return {
        ok: false,
        error: "INVALID_TIME_WINDOW: earliest_available_at must be less than or equal to valid_until",
        status: 400,
      };
    }
    earliestAvailableAt = new Date(earliestMs).toISOString();
  } else {
    if (input.earliest_available_at) {
      const earliestMs = new Date(input.earliest_available_at).getTime();
      if (!isNaN(earliestMs)) {
        earliestAvailableAt = new Date(earliestMs).toISOString();
      }
    }
  }

  const interactionId = typeof input.interaction_id === "string" && input.interaction_id.trim()
    ? input.interaction_id.trim()
    : `${warehouseId}-${Date.now()}`;

  const sourceRef = input.source_ref && typeof input.source_ref === "string"
    ? input.source_ref.trim()
    : `${evidenceStatus}:${interactionId}`;

  const fact: VehicleAvailabilityFact = {
    warehouse_id: warehouseId,
    supplier_name: supplierName,
    vehicle_class: vehicleClass,
    available_count: count,
    earliest_available_at: earliestAvailableAt,
    captured_at: capturedAt,
    valid_until: validUntil,
    supplied_by: finalSuppliedBy,
    supplier_role: finalSupplierRole,
    source_ref: sourceRef,
    evidence_status: evidenceStatus,
  };

  return { ok: true, fact };
}

export async function persistVehicleAvailabilityFact(
  db: SupabaseClient,
  fact: VehicleAvailabilityFact
): Promise<{ ok: true; id: string; superseded_id?: string } | { ok: false; error: string }> {
  try {
    // 1. Try atomic database RPC (Migration 085)
    if (typeof db.rpc === "function") {
      try {
        const { data: rpcData, error: rpcError } = await db.rpc("replace_vehicle_availability_fact", {
          p_warehouse_id: fact.warehouse_id,
          p_supplier_name: fact.supplier_name,
          p_vehicle_class: fact.vehicle_class,
          p_available_count: fact.available_count,
          p_available_at: fact.earliest_available_at || fact.captured_at,
          p_captured_at: fact.captured_at,
          p_valid_until: fact.valid_until,
          p_source_ref: fact.source_ref,
          p_supplied_by: fact.supplied_by,
          p_supplier_role: fact.supplier_role,
          p_supersession_reason: fact.supersession_reason || "DIRECT_OWNER_CORRECTION",
        });

        if (!rpcError && rpcData && rpcData.ok) {
          return {
            ok: true,
            id: rpcData.id,
            superseded_id: rpcData.superseded_id || undefined,
          };
        }
        // If RPC returned a database error that is not "function not found", propagate it
        if (rpcError && !rpcError.message?.includes("function") && !rpcError.message?.includes("not found")) {
          return { ok: false, error: rpcError.message };
        }
      } catch (rpcErr: any) {
        // Fallback for mocks/environments where RPC is not defined
        if (!rpcErr?.message?.includes("not found") && !rpcErr?.message?.includes("function")) {
          return { ok: false, error: rpcErr?.message || String(rpcErr) };
        }
      }
    }

    // 2. Fallback for mock clients / local test environments without RPC
    const capturedMs = new Date(fact.captured_at).getTime();
    const earliestMs = fact.earliest_available_at ? new Date(fact.earliest_available_at).getTime() : capturedMs;
    const isAvailableNow = fact.available_count > 0 && earliestMs <= capturedMs;
    const newId = fact.id || (globalThis.crypto?.randomUUID?.() ?? "mock-fact-uuid");

    // Look for existing unsuperseded fact for this tuple
    let supersededId: string | undefined = undefined;
    try {
      const { data: existingRows } = await db
        .from("vehicle_fleet_availability")
        .select("id")
        .eq("warehouse_id", fact.warehouse_id)
        .eq("supplier_name", fact.supplier_name)
        .eq("vehicle_class", fact.vehicle_class)
        .is("superseded_at", null);

      if (existingRows && existingRows.length > 0 && existingRows[0]?.id) {
        supersededId = existingRows[0].id;
        await db
          .from("vehicle_fleet_availability")
          .update({
            superseded_at: fact.captured_at,
            superseded_by: newId,
            supersession_reason: fact.supersession_reason || "DIRECT_OWNER_CORRECTION",
          })
          .eq("id", supersededId);
      }
    } catch {
      // Ignore if table doesn't have supersession columns in older mock
    }

    const { data, error } = await db
      .from("vehicle_fleet_availability")
      .insert({
        id: newId,
        warehouse_id: fact.warehouse_id,
        supplier_name: fact.supplier_name,
        vehicle_class: fact.vehicle_class,
        available: isAvailableNow,
        available_count: fact.available_count,
        available_at: fact.earliest_available_at || fact.captured_at,
        captured_at: fact.captured_at,
        valid_until: fact.valid_until,
        source_ref: fact.source_ref,
        supplied_by: fact.supplied_by,
        supplier_role: fact.supplier_role,
        supersedes_fact_id: supersededId || null,
      })
      .select("id")
      .single();

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true, id: data?.id || newId, superseded_id: supersededId };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
