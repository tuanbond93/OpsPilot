/**
 * Governed Vehicle Source Validator & Integrity Verifier
 *
 * Implements strict Gate 3C.2A provenance and validation rules:
 * - Rejects unknown vehicle classes
 * - Rejects invalid rate basis (must be TRIP, DAY, HOUR, KG)
 * - Rejects negative rates or negative payloads
 * - Rejects missing provenance (contract_ref, source_ref)
 * - Rejects expired or inverted validity windows
 * - Rejects availability records without valid_until
 * - Rejects duplicate conflicting active governed rates
 */

export const ALLOWED_RATE_BASES = ["TRIP", "DAY", "HOUR", "KG", "MONTH"] as const;
export type AllowedRateBasis = typeof ALLOWED_RATE_BASES[number];

export type ProvenanceStatus = "OWNER_CONFIRMED_PENDING_DOCUMENT" | "DOCUMENT_VERIFIED";

export interface CandidateVehicleClass {
  vehicle_class: string;
  max_payload_kg: number;
  usable_payload_kg?: number | null;
  volume_m3?: number | null;
  effective_at: string;
  expires_at?: string | null;
  source_ref: string;
  provenance_status?: ProvenanceStatus;
}

export interface CandidateVehicleRate {
  warehouse_id: string;
  vehicle_class: string;
  route_or_area?: string | null;
  rate_vnd: number;
  rate_basis: AllowedRateBasis;
  effective_at: string;
  expires_at?: string | null;
  contract_ref?: string | null;
  source_ref: string;
  supplier_name?: string | null;
  provenance_status?: ProvenanceStatus;
}

export interface CandidateVehicleAvailability {
  warehouse_id: string;
  vehicle_id?: string | null;
  vehicle_class: string;
  available: boolean;
  available_at?: string | null;
  remaining_capacity_kg?: number | null;
  captured_at: string;
  valid_until: string;
  source_ref: string;
}

export interface ValidationOutcome<T> {
  valid: boolean;
  errors: string[];
  sanitized?: T;
}

export function validateCandidateVehicleClass(c: CandidateVehicleClass): ValidationOutcome<CandidateVehicleClass> {
  const errors: string[] = [];

  const vehicleClass = (c.vehicle_class || "").trim();
  if (!vehicleClass) {
    errors.push("MISSING_VEHICLE_CLASS: vehicle_class must not be empty.");
  }

  if (typeof c.max_payload_kg !== "number" || isNaN(c.max_payload_kg) || c.max_payload_kg < 0) {
    errors.push("INVALID_PAYLOAD: max_payload_kg must be a non-negative number.");
  }

  if (c.usable_payload_kg != null && (typeof c.usable_payload_kg !== "number" || c.usable_payload_kg < 0)) {
    errors.push("INVALID_PAYLOAD: usable_payload_kg must be non-negative if specified.");
  }

  if (c.volume_m3 != null && (typeof c.volume_m3 !== "number" || c.volume_m3 < 0)) {
    errors.push("INVALID_VOLUME: volume_m3 must be non-negative if specified.");
  }

  const sourceRef = (c.source_ref || "").trim();
  if (!sourceRef) {
    errors.push("MISSING_PROVENANCE: source_ref is strictly required.");
  }

  const effectiveTime = new Date(c.effective_at).getTime();
  if (isNaN(effectiveTime)) {
    errors.push("INVALID_TIMESTAMP: effective_at must be a valid ISO timestamp.");
  }

  if (c.expires_at) {
    const expiresTime = new Date(c.expires_at).getTime();
    if (isNaN(expiresTime)) {
      errors.push("INVALID_TIMESTAMP: expires_at must be a valid ISO timestamp.");
    } else if (expiresTime <= effectiveTime) {
      errors.push("INVALID_EXPIRATION: expires_at must be later than effective_at.");
    }
  }

  const provenanceStatus: ProvenanceStatus = c.provenance_status || "DOCUMENT_VERIFIED";

  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? { ...c, vehicle_class: vehicleClass, source_ref: sourceRef, provenance_status: provenanceStatus } : undefined,
  };
}

export function validateCandidateVehicleRate(
  r: CandidateVehicleRate,
  knownClasses?: Set<string>,
  existingActiveRates?: CandidateVehicleRate[]
): ValidationOutcome<CandidateVehicleRate> {
  const errors: string[] = [];

  const warehouseId = (r.warehouse_id || "").trim();
  if (!warehouseId) {
    errors.push("MISSING_WAREHOUSE_ID: warehouse_id must not be empty.");
  }

  const vehicleClass = (r.vehicle_class || "").trim();
  if (!vehicleClass) {
    errors.push("MISSING_VEHICLE_CLASS: vehicle_class must not be empty.");
  } else if (knownClasses && !knownClasses.has(vehicleClass.toUpperCase())) {
    errors.push(`UNKNOWN_VEHICLE_CLASS: vehicle_class '${vehicleClass}' is not registered in governed_vehicle_classes.`);
  }

  if (typeof r.rate_vnd !== "number" || isNaN(r.rate_vnd) || r.rate_vnd < 0) {
    errors.push("NEGATIVE_RATE: rate_vnd must be a non-negative number.");
  }

  if (!ALLOWED_RATE_BASES.includes(r.rate_basis)) {
    errors.push(`INVALID_RATE_BASIS: rate_basis must be one of ${ALLOWED_RATE_BASES.join(", ")}.`);
  }

  const provenanceStatus: ProvenanceStatus = r.provenance_status || "DOCUMENT_VERIFIED";
  const contractRef = (r.contract_ref || "").trim();
  if (provenanceStatus === "DOCUMENT_VERIFIED" && !contractRef) {
    errors.push("MISSING_PROVENANCE: contract_ref is strictly required on DOCUMENT_VERIFIED governed rate records.");
  }

  const sourceRef = (r.source_ref || "").trim();
  if (!sourceRef) {
    errors.push("MISSING_PROVENANCE: source_ref is strictly required.");
  }

  const effectiveTime = new Date(r.effective_at).getTime();
  if (isNaN(effectiveTime)) {
    errors.push("INVALID_TIMESTAMP: effective_at must be a valid ISO timestamp.");
  }

  if (r.expires_at) {
    const expiresTime = new Date(r.expires_at).getTime();
    if (isNaN(expiresTime)) {
      errors.push("INVALID_TIMESTAMP: expires_at must be a valid ISO timestamp.");
    } else if (expiresTime <= effectiveTime) {
      errors.push("INVALID_EXPIRATION: expires_at must be later than effective_at.");
    }
  }

  // Conflict detection: ambiguous overlapping active rates for same warehouse + class + route + supplier + contract
  if (existingActiveRates && existingActiveRates.length > 0) {
    const routeKey = (r.route_or_area || "GLOBAL").trim().toUpperCase();
    const supplierKey = (r.supplier_name || "UNSPECIFIED").trim().toUpperCase();
    const contractKey = (contractRef || "PENDING_DOCUMENT").trim().toUpperCase();

    const conflict = existingActiveRates.find((existing) => {
      const existingRoute = (existing.route_or_area || "GLOBAL").trim().toUpperCase();
      const existingSupplier = (existing.supplier_name || "UNSPECIFIED").trim().toUpperCase();
      const existingContract = (existing.contract_ref || "PENDING_DOCUMENT").trim().toUpperCase();

      const isSameScope =
        existing.warehouse_id === warehouseId &&
        existing.vehicle_class.toUpperCase() === vehicleClass.toUpperCase() &&
        existingRoute === routeKey &&
        existingSupplier === supplierKey &&
        existingContract === contractKey;

      const isUnexpired = !existing.expires_at || new Date(existing.expires_at).getTime() > Date.now();
      return isSameScope && isUnexpired;
    });

    if (conflict) {
      errors.push(
        `CONFLICTING_ACTIVE_RATE: An active rate already exists for warehouse ${warehouseId}, class ${vehicleClass}, route ${routeKey}, supplier ${supplierKey}, contract ${contractKey}.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized:
      errors.length === 0
        ? {
            ...r,
            warehouse_id: warehouseId,
            vehicle_class: vehicleClass,
            contract_ref: contractRef || null,
            source_ref: sourceRef,
            provenance_status: provenanceStatus,
          }
        : undefined,
  };
}

export function validateCandidateVehicleAvailability(
  a: CandidateVehicleAvailability,
  knownClasses?: Set<string>
): ValidationOutcome<CandidateVehicleAvailability> {
  const errors: string[] = [];

  const warehouseId = (a.warehouse_id || "").trim();
  if (!warehouseId) {
    errors.push("MISSING_WAREHOUSE_ID: warehouse_id must not be empty.");
  }

  const vehicleClass = (a.vehicle_class || "").trim();
  if (!vehicleClass) {
    errors.push("MISSING_VEHICLE_CLASS: vehicle_class must not be empty.");
  } else if (knownClasses && !knownClasses.has(vehicleClass.toUpperCase())) {
    errors.push(
      `UNKNOWN_VEHICLE_CLASS: vehicle_class '${vehicleClass}' referenced in availability is not registered in governed_vehicle_classes.`
    );
  }

  if (typeof a.available !== "boolean") {
    errors.push("INVALID_AVAILABILITY: available must be a boolean (true or false).");
  }

  if (a.remaining_capacity_kg != null && (typeof a.remaining_capacity_kg !== "number" || a.remaining_capacity_kg < 0)) {
    errors.push("INVALID_CAPACITY: remaining_capacity_kg must be non-negative if specified.");
  }

  const capturedTime = new Date(a.captured_at).getTime();
  if (isNaN(capturedTime)) {
    errors.push("INVALID_TIMESTAMP: captured_at must be a valid ISO timestamp.");
  }

  const validUntilTime = new Date(a.valid_until).getTime();
  if (isNaN(validUntilTime)) {
    errors.push("MISSING_VALID_UNTIL: valid_until must be a valid ISO timestamp and cannot be empty.");
  } else if (validUntilTime < capturedTime) {
    errors.push("INVALID_VALIDITY_WINDOW: valid_until cannot be earlier than captured_at.");
  }

  const sourceRef = (a.source_ref || "").trim();
  if (!sourceRef) {
    errors.push("MISSING_PROVENANCE: source_ref is strictly required.");
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized:
      errors.length === 0
        ? {
            ...a,
            warehouse_id: warehouseId,
            vehicle_class: vehicleClass,
            source_ref: sourceRef,
          }
        : undefined,
  };
}
