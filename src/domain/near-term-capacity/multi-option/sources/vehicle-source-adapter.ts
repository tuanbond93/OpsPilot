/**
 * Gate 3C.1 Governed Vehicle Economics & Capacity Source Integration
 *
 * Provides normalized, read-only contracts and adapters for:
 * 1. Vehicle Rates (Group A)
 * 2. Vehicle Capacity (Group B)
 * 3. Vehicle Availability (Group C)
 *
 * STRICT GOVERNANCE INVARIANTS:
 * - Never fabricate or hardcode arbitrary rates into decision logic.
 * - Missing rate -> incremental_cost_vnd = null, evidence_status = "UNKNOWN".
 * - Missing vehicle class -> capacity = null, evidence_status = "UNKNOWN".
 * - Missing availability -> feasibility cannot be FEASIBLE (must be UNKNOWN or CONDITIONALLY_FEASIBLE).
 * - Capacity is NEVER inferred from vehicle name alone without a governed mapping.
 * - Stale rate (> 30 days or past expiry) is rejected / marked stale.
 * - Unavailable vehicle (available = false) cannot be selected.
 */

export type RateBasis = "TRIP" | "HOUR" | "DAY" | "KG" | "MONTH";
export type VehicleRateEvidenceStatus = "MEASURED" | "GOVERNED_RATE" | "OWNER_CONFIRMED" | "MODELED" | "UNKNOWN";

export interface VehicleRateEvidence {
  vehicle_class: string;
  warehouse_or_scope: string;
  route_or_area?: string | null;
  rate_vnd: number | null;
  rate_basis: RateBasis | null;
  source_ref: string | null;
  effective_at: string | null;
  evidence_status: VehicleRateEvidenceStatus;
  is_stale?: boolean;
  stale_reason?: string | null;
  supplier_name?: string | null;
  contract_ref?: string | null;
  provenance_status?: "OWNER_CONFIRMED_PENDING_DOCUMENT" | "DOCUMENT_VERIFIED" | null;
}

export type VehicleCapacityEvidenceStatus = "MEASURED" | "GOVERNED" | "OWNER_CONFIRMED" | "MODELED" | "UNKNOWN";

export interface VehicleCapacityEvidence {
  vehicle_class: string;
  max_payload_kg: number | null;
  usable_payload_kg: number | null;
  volume_m3: number | null;
  source_ref: string | null;
  effective_at: string | null;
  evidence_status: VehicleCapacityEvidenceStatus;
  provenance_status?: "OWNER_CONFIRMED_PENDING_DOCUMENT" | "DOCUMENT_VERIFIED" | null;
}

import type { VehicleAvailabilityStatus } from "../types";
export type { VehicleAvailabilityStatus } from "../types";

export type VehicleAvailabilityEvidenceStatus =
  | "MEASURED"
  | "GOVERNED"
  | "OWNER_CONFIRMED"
  | "MODELED"
  | "AUTHORIZED_OPERATIONAL_FACT"
  | "SYSTEM_AUTHORIZED_IMPORT"
  | "OWNER_CONFIRMED_RECURRING_SCHEDULE"
  | "UNKNOWN";

export type AuthorizedOperationalRole =
  | "WAREHOUSE_LEAD"
  | "DISPATCH_MANAGER"
  | "OPERATIONS_MANAGER"
  | "SYSTEM_ADMIN"
  | "LEAD"
  | "MANAGER"
  | "ADMIN";

export interface VehicleAvailabilitySchedule {
  warehouse_id: string;
  supplier_name: string;
  vehicle_class: string;
  planned_available_count: number;
  recurrence_type: "DAILY";
  timezone: string;
  local_start_time: string;
  local_end_time: string;
  effective_from: string;
  effective_until?: string | null;
  supplied_by: string;
  supplier_role: AuthorizedOperationalRole;
  source_ref: string;
  provenance_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE";
}

export function getNextCalendarDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

export function normalizeTimeString(timeStr: string): string {
  if (!timeStr) return "00:00:00";
  const parts = timeStr.split(":").map((v) => parseInt(v, 10));
  const h = String(isNaN(parts[0]) ? 0 : parts[0]).padStart(2, "0");
  const m = String(isNaN(parts[1]) ? 0 : parts[1]).padStart(2, "0");
  const s = String(isNaN(parts[2]) ? 0 : parts[2]).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function getTimeZoneOffsetString(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName")?.value;
    if (tzPart) {
      if (tzPart === "GMT") return "+00:00";
      const match = tzPart.match(/GMT([+-]\d{1,2}):?(\d{2})?/);
      if (match) {
        const signAndHour = match[1].startsWith("+") || match[1].startsWith("-")
          ? match[1][0] + match[1].slice(1).padStart(2, "0")
          : "+" + match[1].padStart(2, "0");
        const min = match[2] || "00";
        return `${signAndHour}:${min}`;
      }
    }
  } catch {}
  return "+07:00";
}

export function evaluateDailyWindow(
  evalTime: number | string | Date,
  startTime: string = "07:00",
  endTime: string = "10:00",
  timeZone: string = "Asia/Ho_Chi_Minh"
): {
  isWithinWindow: boolean;
  isBeforeWindow: boolean;
  isAfterWindow: boolean;
  status: "PLANNED_AVAILABLE_NOW" | "SCHEDULED_AVAILABLE";
  localDate: string;
  localTime: string;
  targetDate: string;
} {
  const dateObj = new Date(evalTime);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(dateObj);
  let year = "1970", month = "01", day = "01", hour = "00", minute = "00", second = "00";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    if (p.type === "month") month = p.value;
    if (p.type === "day") day = p.value;
    if (p.type === "hour") hour = p.value;
    if (p.type === "minute") minute = p.value;
    if (p.type === "second") second = p.value;
  }
  const currentSeconds = (parseInt(hour, 10) * 60 + parseInt(minute, 10)) * 60 + parseInt(second, 10);

  const [startH, startM, startS] = startTime.split(":").map((v) => parseInt(v, 10));
  const [endH, endM, endS] = endTime.split(":").map((v) => parseInt(v, 10));
  const startSeconds = ((startH || 0) * 60 + (startM || 0)) * 60 + (startS || 0);
  const endSeconds = ((endH || 0) * 60 + (endM || 0)) * 60 + (endS || 0);

  const localDate = `${year}-${month}-${day}`;
  const localTime = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  if (currentSeconds >= startSeconds && currentSeconds < endSeconds) {
    return {
      isWithinWindow: true,
      isBeforeWindow: false,
      isAfterWindow: false,
      status: "PLANNED_AVAILABLE_NOW",
      localDate,
      localTime,
      targetDate: localDate,
    };
  } else if (currentSeconds < startSeconds) {
    return {
      isWithinWindow: false,
      isBeforeWindow: true,
      isAfterWindow: false,
      status: "SCHEDULED_AVAILABLE",
      localDate,
      localTime,
      targetDate: localDate,
    };
  } else {
    return {
      isWithinWindow: false,
      isBeforeWindow: false,
      isAfterWindow: true,
      status: "SCHEDULED_AVAILABLE",
      localDate,
      localTime,
      targetDate: getNextCalendarDate(localDate),
    };
  }
}

function parseEffectiveDate(dateStr: string, isEnd = false, timeZone = "Asia/Ho_Chi_Minh"): number {
  if (!dateStr) return isEnd ? Infinity : -Infinity;
  if (dateStr.length === 10 && dateStr.includes("-")) {
    const timePart = isEnd ? "23:59:59" : "00:00:00";
    const sampleDate = new Date(`${dateStr}T12:00:00Z`);
    const offset = getTimeZoneOffsetString(sampleDate, timeZone);
    return new Date(`${dateStr}T${timePart}${offset}`).getTime();
  }
  return new Date(dateStr).getTime();
}

export function evaluateScheduleEvidence(
  sched: VehicleAvailabilitySchedule | any,
  evalMs: number,
  warehouseId: string,
  vehicleClass: string
): VehicleAvailabilityEvidence | null {
  const tz = sched.timezone || "Asia/Ho_Chi_Minh";

  if (sched.effective_from) {
    const fromMs = parseEffectiveDate(sched.effective_from, false, tz);
    if (!isNaN(fromMs) && evalMs < fromMs) {
      return null;
    }
  }
  if (sched.effective_until) {
    const untilMs = parseEffectiveDate(sched.effective_until, true, tz);
    if (!isNaN(untilMs) && evalMs > untilMs) {
      return null;
    }
  }

  const rawStartTime = sched.local_start_time || "07:00";
  const rawEndTime = sched.local_end_time || "10:00";

  const windowEval = evaluateDailyWindow(
    evalMs,
    rawStartTime,
    rawEndTime,
    tz
  );

  const targetDate = windowEval.targetDate;
  const normStartTime = normalizeTimeString(rawStartTime);
  const normEndTime = normalizeTimeString(rawEndTime);

  const sampleTargetDate = new Date(`${targetDate}T12:00:00Z`);
  const tzOffset = getTimeZoneOffsetString(sampleTargetDate, tz);

  const earliestAvailableAt = `${targetDate}T${normStartTime}${tzOffset}`;
  const validUntil = `${targetDate}T${normEndTime}${tzOffset}`;

  // Check effective_until boundary against the target window
  if (sched.effective_until) {
    const untilMs = parseEffectiveDate(sched.effective_until, true, tz);
    const targetStartMs = new Date(earliestAvailableAt).getTime();
    if (!isNaN(untilMs) && targetStartMs > untilMs) {
      return null;
    }
  }

  return {
    warehouse_id: sched.warehouse_id || warehouseId,
    vehicle_id: null,
    vehicle_class: sched.vehicle_class || vehicleClass,
    available: false,
    availability_status: windowEval.status,
    available_at: earliestAvailableAt,
    remaining_capacity_kg: null,
    source_ref: sched.source_ref,
    captured_at: sched.effective_from || new Date(evalMs).toISOString(),
    evidence_status: "OWNER_CONFIRMED_RECURRING_SCHEDULE",
    supplier_name: sched.supplier_name,
    available_count: sched.planned_available_count,
    earliest_available_at: earliestAvailableAt,
    valid_until: validUntil,
    supplied_by: sched.supplied_by || null,
    supplier_role: sched.supplier_role || null,
  };
}

export interface VehicleAvailabilityEvidence {
  warehouse_id: string;
  vehicle_id: string | null;
  vehicle_class: string | null;
  available: boolean | null;
  availability_status: VehicleAvailabilityStatus;
  available_at: string | null;
  remaining_capacity_kg: number | null;
  source_ref: string | null;
  captured_at: string | null;
  evidence_status: VehicleAvailabilityEvidenceStatus;
  supplier_name?: string | null;
  available_count?: number | null;
  earliest_available_at?: string | null;
  valid_until?: string | null;
  supplied_by?: string | null;
  supplier_role?: string | null;
  superseded_at?: string | null;
  superseded_by?: string | null;
  supersedes_fact_id?: string | null;
  supersession_reason?: string | null;
  is_superseded?: boolean;
}

export interface VehicleAvailabilityFact {
  id?: string;
  warehouse_id: string;
  supplier_name: string;
  vehicle_class: string;
  available_count: number;
  earliest_available_at?: string | null;
  captured_at: string;
  valid_until: string;
  supplied_by: string;
  supplier_role: AuthorizedOperationalRole;
  source_ref: string;
  evidence_status: "AUTHORIZED_OPERATIONAL_FACT" | "SYSTEM_AUTHORIZED_IMPORT";
  superseded_at?: string | null;
  superseded_by?: string | null;
  supersedes_fact_id?: string | null;
  supersession_reason?: string | null;
}

export interface VehicleEconomicsAndCapacityResult {
  rate: VehicleRateEvidence;
  rates?: VehicleRateEvidence[];
  capacity: VehicleCapacityEvidence;
  availability: VehicleAvailabilityEvidence;
  availabilities?: VehicleAvailabilityEvidence[];
}

export interface VehicleSourceAdapter {
  getVehicleRate(warehouseId: string, vehicleClass?: string, supplierName?: string): Promise<VehicleRateEvidence> | VehicleRateEvidence;
  getVehicleRates?(warehouseId: string, vehicleClass?: string): Promise<VehicleRateEvidence[]> | VehicleRateEvidence[];
  getVehicleCapacity(vehicleClass?: string): Promise<VehicleCapacityEvidence> | VehicleCapacityEvidence;
  getVehicleAvailability(warehouseId: string, vehicleClass?: string, supplierName?: string, evaluationTime?: string | number | Date): Promise<VehicleAvailabilityEvidence> | VehicleAvailabilityEvidence;
  getVehicleAvailabilities?(warehouseId: string, vehicleClass?: string, evaluationTime?: string | number | Date): Promise<VehicleAvailabilityEvidence[]> | VehicleAvailabilityEvidence[];
  getVehicleEvidence(warehouseId: string, vehicleClass?: string, evaluationTime?: string | number | Date): Promise<VehicleEconomicsAndCapacityResult> | VehicleEconomicsAndCapacityResult;
}

export function computeAvailabilityStatus(
  availableCount: number | null | undefined,
  earliestAvailableAt: string | null | undefined,
  validUntil: string | null | undefined,
  evaluationTime: number,
  fallbackAvailable?: boolean | null
): { status: VehicleAvailabilityStatus; available: boolean | null } {
  const validUntilMs = validUntil ? new Date(validUntil).getTime() : Infinity;
  if (evaluationTime > validUntilMs) {
    return { status: "UNKNOWN", available: null };
  }

  if (availableCount !== undefined && availableCount !== null) {
    if (availableCount === 0) {
      return { status: "UNAVAILABLE", available: false };
    }
    if (availableCount > 0) {
      if (!earliestAvailableAt) {
        return { status: "UNKNOWN", available: null };
      }
      const earliestMs = new Date(earliestAvailableAt).getTime();
      if (isNaN(earliestMs) || earliestMs > validUntilMs) {
        return { status: "UNKNOWN", available: null };
      }
      if (earliestMs <= evaluationTime && evaluationTime <= validUntilMs) {
        return { status: "AVAILABLE_NOW", available: true };
      }
      if (earliestMs > evaluationTime && earliestMs <= validUntilMs) {
        return { status: "SCHEDULED_AVAILABLE", available: false };
      }
      return { status: "UNKNOWN", available: null };
    }
  }

  if (fallbackAvailable === true) {
    return { status: "AVAILABLE_NOW", available: true };
  }
  if (fallbackAvailable === false) {
    return { status: "UNAVAILABLE", available: false };
  }
  return { status: "UNKNOWN", available: null };
}

import type { SupabaseClient } from "@supabase/supabase-js";

export interface GovernedRateRecord {
  vehicle_class: string;
  warehouse_or_scope?: string;
  route_or_area?: string;
  rate_vnd: number;
  rate_basis: RateBasis;
  source_ref: string;
  effective_at: string;
  expires_at?: string;
  is_stale?: boolean;
  supplier_name?: string | null;
  contract_ref?: string | null;
  provenance_status?: "OWNER_CONFIRMED_PENDING_DOCUMENT" | "DOCUMENT_VERIFIED" | null;
}

export interface GovernedCapacityRecord {
  max_payload_kg: number;
  usable_payload_kg: number;
  volume_m3?: number;
  source_ref: string;
  effective_at: string;
  provenance_status?: "OWNER_CONFIRMED_PENDING_DOCUMENT" | "DOCUMENT_VERIFIED" | null;
}

export interface GovernedAvailabilityRecord {
  warehouse_id: string;
  vehicle_id?: string | null;
  vehicle_class: string;
  available: boolean;
  available_at?: string | null;
  remaining_capacity_kg?: number | null;
  source_ref: string;
  captured_at?: string | null;
  valid_until?: string | null;
  supplier_name?: string | null;
  available_count?: number | null;
  earliest_available_at?: string | null;
  supplied_by?: string | null;
  supplier_role?: string | null;
  evidence_status?: VehicleAvailabilityEvidenceStatus;
  superseded_at?: string | null;
  superseded_by?: string | null;
  supersedes_fact_id?: string | null;
  supersession_reason?: string | null;
}

export interface GovernedVehicleSourceConfig {
  db?: SupabaseClient;
  rates?: GovernedRateRecord[];
  capacities?: Record<string, GovernedCapacityRecord>;
  availabilities?: GovernedAvailabilityRecord[];
  availabilityFacts?: VehicleAvailabilityFact[];
  schedules?: VehicleAvailabilitySchedule[];
  maxRateAgeDays?: number;
  evaluationTime?: string | number | Date;
}

export class GovernedVehicleSourceAdapter implements VehicleSourceAdapter {
  private readonly config: GovernedVehicleSourceConfig;

  constructor(config: GovernedVehicleSourceConfig = {}) {
    this.config = config;
  }

  getVehicleRate(warehouseId: string, vehicleClass = "STANDARD_EXTERNAL_TRUCK", supplierName?: string): any {
    if (this.config.db) {
      return this.queryDbRate(warehouseId, vehicleClass, supplierName);
    }
    return this.getInMemoryRate(warehouseId, vehicleClass, supplierName);
  }

  getVehicleRates(warehouseId: string, vehicleClass = "STANDARD_EXTERNAL_TRUCK"): any {
    if (this.config.db) {
      return this.queryDbRates(warehouseId, vehicleClass);
    }
    return this.getInMemoryRates(warehouseId, vehicleClass);
  }

  getVehicleCapacity(vehicleClass = "STANDARD_EXTERNAL_TRUCK"): any {
    if (this.config.db) {
      return this.queryDbCapacity(vehicleClass);
    }
    return this.getInMemoryCapacity(vehicleClass);
  }

  getVehicleAvailability(
    warehouseId: string,
    vehicleClass?: string,
    supplierName?: string,
    evaluationTime?: string | number | Date
  ): any {
    if (this.config.db) {
      return this.queryDbAvailability(warehouseId, vehicleClass, supplierName, evaluationTime);
    }
    return this.getInMemoryAvailability(warehouseId, vehicleClass, supplierName, evaluationTime);
  }

  getVehicleAvailabilities(
    warehouseId: string,
    vehicleClass?: string,
    evaluationTime?: string | number | Date
  ): any {
    if (this.config.db) {
      return this.queryDbAvailabilities(warehouseId, vehicleClass, evaluationTime);
    }
    return this.getInMemoryAvailabilities(warehouseId, vehicleClass, evaluationTime);
  }

  getVehicleEvidence(
    warehouseId: string,
    vehicleClass?: string,
    evaluationTime?: string | number | Date
  ): any {
    if (this.config.db) {
      return this.queryDbEvidence(warehouseId, vehicleClass, evaluationTime);
    }

    const availabilities = this.getInMemoryAvailabilities(warehouseId, vehicleClass, evaluationTime);
    const availability =
      availabilities[0] ||
      this.getInMemoryAvailability(warehouseId, vehicleClass, undefined, evaluationTime);
    let targetClass = vehicleClass || availability.vehicle_class;
    if (!targetClass) {
      const matched = (this.config.rates || []).find(
        (r) => !r.is_stale && (!r.warehouse_or_scope || r.warehouse_or_scope === warehouseId)
      );
      if (matched) {
        targetClass = matched.vehicle_class;
      }
    }
    if (!targetClass) {
      targetClass = "TRUCK_1_9T";
    }
    const rates = this.getInMemoryRates(warehouseId, targetClass);
    const rate = rates.find((r) => r.warehouse_or_scope === warehouseId) || rates[0] || {
      vehicle_class: targetClass,
      warehouse_or_scope: warehouseId,
      route_or_area: null,
      rate_vnd: null,
      rate_basis: null,
      source_ref: null,
      effective_at: null,
      evidence_status: "UNKNOWN" as const,
      is_stale: false,
    };
    const capacity = this.getInMemoryCapacity(targetClass);

    return {
      rate,
      rates,
      capacity,
      availability,
      availabilities,
    };
  }

  private async queryDbRates(warehouseId: string, vehicleClass: string): Promise<VehicleRateEvidence[]> {
    try {
      const { data, error } = await this.config.db!
        .from("governed_vehicle_rates")
        .select("*")
        .eq("vehicle_class", vehicleClass)
        .in("warehouse_id", [warehouseId, "GLOBAL"])
        .order("created_at", { ascending: false });

      if (error || !data || data.length === 0) {
        return [];
      }

      const now = Date.now();
      return data.map((matched: any) => {
        const isPastExpiry = Boolean(matched.expires_at && now > new Date(matched.expires_at).getTime());
        if (isPastExpiry) {
          return {
            vehicle_class: matched.vehicle_class,
            warehouse_or_scope: matched.warehouse_or_scope || matched.warehouse_id,
            route_or_area: matched.route_or_area || null,
            rate_vnd: null,
            rate_basis: matched.rate_basis,
            source_ref: matched.source_ref,
            effective_at: matched.effective_at,
            evidence_status: "UNKNOWN" as const,
            is_stale: true,
            stale_reason: `Biểu phí đã hết hạn vào ngày ${matched.expires_at}`,
            supplier_name: matched.supplier_name || null,
            contract_ref: matched.contract_ref || null,
            provenance_status: matched.provenance_status || null,
          };
        }

        const status: VehicleRateEvidenceStatus =
          matched.provenance_status === "OWNER_CONFIRMED_PENDING_DOCUMENT"
            ? "OWNER_CONFIRMED"
            : "GOVERNED_RATE";

        return {
          vehicle_class: matched.vehicle_class,
          warehouse_or_scope: matched.warehouse_or_scope || matched.warehouse_id,
          route_or_area: matched.route_or_area || null,
          rate_vnd: Number(matched.rate_vnd),
          rate_basis: matched.rate_basis,
          source_ref: matched.source_ref,
          effective_at: matched.effective_at,
          evidence_status: status,
          is_stale: false,
          supplier_name: matched.supplier_name || null,
          contract_ref: matched.contract_ref || null,
          provenance_status: matched.provenance_status || null,
        };
      });
    } catch {
      return [];
    }
  }

  private async queryDbRate(warehouseId: string, vehicleClass: string, supplierName?: string): Promise<VehicleRateEvidence> {
    const all = await this.queryDbRates(warehouseId, vehicleClass);
    if (all.length === 0) {
      return {
        vehicle_class: vehicleClass,
        warehouse_or_scope: warehouseId,
        route_or_area: null,
        rate_vnd: null,
        rate_basis: null,
        source_ref: null,
        effective_at: null,
        evidence_status: "UNKNOWN",
        is_stale: false,
      };
    }

    if (supplierName) {
      const specific = all.find(
        (r) => r.supplier_name && r.supplier_name.toUpperCase() === supplierName.toUpperCase()
      );
      if (specific) return specific;
    }

    const warehouseSpecific = all.find((r) => r.warehouse_or_scope === warehouseId);
    return warehouseSpecific || all[0];
  }

  private getInMemoryRates(warehouseId: string, vehicleClass: string): VehicleRateEvidence[] {
    const rates = this.config.rates || [];
    const matched = rates.filter(
      (r) =>
        r.vehicle_class.toUpperCase() === vehicleClass.toUpperCase() &&
        (!r.warehouse_or_scope || r.warehouse_or_scope === warehouseId || r.warehouse_or_scope === "GLOBAL")
    );

    if (matched.length === 0) {
      return [];
    }

    const now = Date.now();
    const maxAgeMs = (this.config.maxRateAgeDays || 30) * 24 * 60 * 60 * 1000;

    return matched.map((m) => {
      const effectiveTime = m.effective_at ? new Date(m.effective_at).getTime() : 0;
      const expiresTime = m.expires_at ? new Date(m.expires_at).getTime() : Infinity;

      const isPastExpiry = Boolean(m.expires_at && now > expiresTime);
      const isPastMaxAge = effectiveTime > 0 && now - effectiveTime > maxAgeMs;
      const isExplicitlyStale = m.is_stale === true;

      if (isPastExpiry || isPastMaxAge || isExplicitlyStale) {
        return {
          vehicle_class: m.vehicle_class,
          warehouse_or_scope: m.warehouse_or_scope || warehouseId,
          route_or_area: m.route_or_area || null,
          rate_vnd: null,
          rate_basis: m.rate_basis,
          source_ref: m.source_ref,
          effective_at: m.effective_at,
          evidence_status: "UNKNOWN" as const,
          is_stale: true,
          stale_reason: isPastExpiry
            ? `Biểu phí đã hết hạn vào ngày ${m.expires_at}`
            : `Biểu phí đã quá thời hạn hiệu lực tối đa (${this.config.maxRateAgeDays || 30} ngày)`,
          supplier_name: m.supplier_name || null,
          contract_ref: m.contract_ref || null,
        };
      }

      const status: VehicleRateEvidenceStatus =
        m.provenance_status === "OWNER_CONFIRMED_PENDING_DOCUMENT"
          ? "OWNER_CONFIRMED"
          : "GOVERNED_RATE";

      return {
        vehicle_class: m.vehicle_class,
        warehouse_or_scope: m.warehouse_or_scope || warehouseId,
        route_or_area: m.route_or_area || null,
        rate_vnd: m.rate_vnd,
        rate_basis: m.rate_basis,
        source_ref: m.source_ref,
        effective_at: m.effective_at,
        evidence_status: status,
        is_stale: false,
        supplier_name: m.supplier_name || null,
        contract_ref: m.contract_ref || null,
        provenance_status: m.provenance_status || null,
      };
    });
  }

  private getInMemoryRate(warehouseId: string, vehicleClass: string, supplierName?: string): VehicleRateEvidence {
    const all = this.getInMemoryRates(warehouseId, vehicleClass);
    if (all.length === 0) {
      return {
        vehicle_class: vehicleClass,
        warehouse_or_scope: warehouseId,
        route_or_area: null,
        rate_vnd: null,
        rate_basis: null,
        source_ref: null,
        effective_at: null,
        evidence_status: "UNKNOWN",
        is_stale: false,
      };
    }

    if (supplierName) {
      const specific = all.find(
        (r) => r.supplier_name && r.supplier_name.toUpperCase() === supplierName.toUpperCase()
      );
      if (specific) return specific;
    }

    const warehouseSpecific = all.find((r) => r.warehouse_or_scope === warehouseId);
    return warehouseSpecific || all[0];
  }

  private async queryDbCapacity(vehicleClass: string): Promise<VehicleCapacityEvidence> {
    try {
      const { data, error } = await this.config.db!
        .from("governed_vehicle_classes")
        .select("*")
        .eq("vehicle_class", vehicleClass)
        .maybeSingle();

      if (error || !data) {
        return {
          vehicle_class: vehicleClass,
          max_payload_kg: null,
          usable_payload_kg: null,
          volume_m3: null,
          source_ref: null,
          effective_at: null,
          evidence_status: "UNKNOWN",
        };
      }

      const now = Date.now();
      const isPastExpiry = Boolean(data.expires_at && now > new Date(data.expires_at).getTime());
      if (isPastExpiry) {
        return {
          vehicle_class: data.vehicle_class,
          max_payload_kg: null,
          usable_payload_kg: null,
          volume_m3: null,
          source_ref: data.source_ref,
          effective_at: data.effective_at,
          evidence_status: "UNKNOWN",
        };
      }

      const status: VehicleCapacityEvidenceStatus =
        data.provenance_status === "OWNER_CONFIRMED_PENDING_DOCUMENT"
          ? "OWNER_CONFIRMED"
          : "GOVERNED";

      return {
        vehicle_class: data.vehicle_class,
        max_payload_kg: Number(data.max_payload_kg),
        usable_payload_kg: data.usable_payload_kg != null ? Number(data.usable_payload_kg) : null,
        volume_m3: data.volume_m3 != null ? Number(data.volume_m3) : null,
        source_ref: data.source_ref,
        effective_at: data.effective_at,
        evidence_status: status,
        provenance_status: data.provenance_status || null,
      };
    } catch {
      return {
        vehicle_class: vehicleClass,
        max_payload_kg: null,
        usable_payload_kg: null,
        volume_m3: null,
        source_ref: null,
        effective_at: null,
        evidence_status: "UNKNOWN",
      };
    }
  }

  private getInMemoryCapacity(vehicleClass: string): VehicleCapacityEvidence {
    const capacities = this.config.capacities || {};
    const record = capacities[vehicleClass.toUpperCase()];

    if (!record) {
      return {
        vehicle_class: vehicleClass,
        max_payload_kg: null,
        usable_payload_kg: null,
        volume_m3: null,
        source_ref: null,
        effective_at: null,
        evidence_status: "UNKNOWN",
      };
    }

    const status: VehicleCapacityEvidenceStatus =
      record.provenance_status === "OWNER_CONFIRMED_PENDING_DOCUMENT"
        ? "OWNER_CONFIRMED"
        : "GOVERNED";

    return {
      vehicle_class: vehicleClass,
      max_payload_kg: record.max_payload_kg,
      usable_payload_kg: record.usable_payload_kg,
      volume_m3: record.volume_m3 ?? null,
      source_ref: record.source_ref,
      effective_at: record.effective_at,
      evidence_status: status,
      provenance_status: record.provenance_status || null,
    };
  }

  private async queryDbAvailabilities(
    warehouseId: string,
    vehicleClass?: string,
    evaluationTime?: string | number | Date
  ): Promise<VehicleAvailabilityEvidence[]> {
    try {
      let query: any = this.config.db!
        .from("vehicle_fleet_availability")
        .select("*")
        .eq("warehouse_id", warehouseId);

      if (vehicleClass) {
        query = query.eq("vehicle_class", vehicleClass);
      }

      query = query.order("captured_at", { ascending: false });

      let data: any = null;
      let error: any = null;

      if (typeof query.then === "function") {
        const res = await query;
        data = res?.data;
        error = res?.error;
      } else if (typeof query.maybeSingle === "function") {
        const res = await query.maybeSingle();
        data = res?.data ? (Array.isArray(res.data) ? res.data : [res.data]) : [];
        error = res?.error;
      }

      const rows: any[] = (!error && data) ? (Array.isArray(data) ? data : [data]) : [];

      // Query recurring schedules if table exists (fail-soft)
      let schedRows: any[] = [];
      try {
        let schedQuery: any = this.config.db!
          .from("vehicle_fleet_availability_schedules")
          .select("*")
          .eq("warehouse_id", warehouseId);

        if (vehicleClass) {
          schedQuery = schedQuery.eq("vehicle_class", vehicleClass);
        }

        if (typeof schedQuery.then === "function") {
          const res = await schedQuery;
          schedRows = res?.data || [];
        }
      } catch {
        schedRows = [];
      }

      const evalMs = evaluationTime
        ? new Date(evaluationTime).getTime()
        : this.config.evaluationTime
        ? new Date(this.config.evaluationTime).getTime()
        : Date.now();

      // 1. Process point-in-time facts
      const liveBySupplier = new Map<string, VehicleAvailabilityEvidence>();
      const unassociatedLive: VehicleAvailabilityEvidence[] = [];

      for (const row of rows) {
        // Skip superseded facts: only CURRENT unsuperseded facts participate in live evaluation
        if (row.superseded_at) {
          continue;
        }

        const isOperationalFact =
          (typeof row.source_ref === "string" && row.source_ref.startsWith("AUTHORIZED_OPERATIONAL_FACT")) ||
          row.evidence_status === "AUTHORIZED_OPERATIONAL_FACT";
        const isSystemImport =
          (typeof row.source_ref === "string" && row.source_ref.startsWith("SYSTEM_AUTHORIZED_IMPORT")) ||
          row.evidence_status === "SYSTEM_AUTHORIZED_IMPORT";

        const baseStatus: VehicleAvailabilityEvidenceStatus = isOperationalFact
          ? "AUTHORIZED_OPERATIONAL_FACT"
          : isSystemImport
          ? "SYSTEM_AUTHORIZED_IMPORT"
          : "GOVERNED";

        const { status: availStatus, available } = computeAvailabilityStatus(
          row.available_count,
          row.available_at || row.earliest_available_at,
          row.valid_until,
          evalMs,
          row.available
        );

        const ev: VehicleAvailabilityEvidence = {
          warehouse_id: row.warehouse_id,
          vehicle_id: row.vehicle_id ?? null,
          vehicle_class: row.vehicle_class,
          available,
          availability_status: availStatus,
          available_at: row.available_at ?? null,
          remaining_capacity_kg: row.remaining_capacity_kg != null ? Number(row.remaining_capacity_kg) : null,
          source_ref: row.source_ref,
          captured_at: row.captured_at,
          evidence_status: availStatus === "UNKNOWN" ? ("UNKNOWN" as const) : baseStatus,
          supplier_name: row.supplier_name ?? null,
          available_count: row.available_count ?? (available === true ? 1 : 0),
          earliest_available_at: row.available_at ?? row.earliest_available_at ?? null,
          valid_until: row.valid_until ?? null,
          supplied_by: row.supplied_by ?? null,
          supplier_role: row.supplier_role ?? null,
          superseded_at: row.superseded_at ?? null,
          superseded_by: row.superseded_by ?? null,
          supersedes_fact_id: row.supersedes_fact_id ?? null,
          supersession_reason: row.supersession_reason ?? null,
          is_superseded: false,
        };

        const supKey = (row.supplier_name || "").toUpperCase();
        if (supKey) {
          // Deterministic latest-wins: rows are ordered captured_at DESC.
          // Once the newest CURRENT unsuperseded fact is recorded, older rows for the same supplier never overwrite it.
          if (!liveBySupplier.has(supKey)) {
            liveBySupplier.set(supKey, ev);
          }
        } else {
          unassociatedLive.push(ev);
        }
      }

      // 2. Process recurring schedules
      const schedBySupplier = new Map<string, VehicleAvailabilityEvidence>();
      for (const sRow of schedRows) {
        const ev = evaluateScheduleEvidence(sRow, evalMs, warehouseId, vehicleClass || sRow.vehicle_class);
        if (ev && sRow.supplier_name) {
          schedBySupplier.set(sRow.supplier_name.toUpperCase(), ev);
        }
      }

      // 3. Precedence: Fresh live fact > Recurring schedule > Expired live fact > UNKNOWN
      const allSuppliers = new Set<string>([
        ...liveBySupplier.keys(),
        ...schedBySupplier.keys(),
      ]);

      const results: VehicleAvailabilityEvidence[] = [];
      for (const supKey of allSuppliers) {
        const liveEv = liveBySupplier.get(supKey);
        const schedEv = schedBySupplier.get(supKey);

        if (liveEv && liveEv.availability_status !== "UNKNOWN") {
          results.push(liveEv);
        } else if (schedEv) {
          results.push(schedEv);
        } else if (liveEv) {
          results.push(liveEv);
        }
      }

      results.push(...unassociatedLive);
      return results;
    } catch {
      return [];
    }
  }

  private async queryDbAvailability(
    warehouseId: string,
    vehicleClass?: string,
    supplierName?: string,
    evaluationTime?: string | number | Date
  ): Promise<VehicleAvailabilityEvidence> {
    const all = await this.queryDbAvailabilities(warehouseId, vehicleClass, evaluationTime);
    if (supplierName) {
      const match = all.find(
        (a) => a.supplier_name && a.supplier_name.toUpperCase() === supplierName.toUpperCase()
      );
      if (match) return match;
      return {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: vehicleClass || null,
        available: null,
        availability_status: "UNKNOWN",
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
        supplier_name: supplierName,
      };
    }
    return (
      all[0] || {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: vehicleClass || null,
        available: null,
        availability_status: "UNKNOWN",
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
        supplier_name: supplierName || null,
      }
    );
  }

  private getInMemoryAvailabilities(
    warehouseId: string,
    vehicleClass?: string,
    evaluationTime?: string | number | Date
  ): VehicleAvailabilityEvidence[] {
    const evalMs = evaluationTime
      ? new Date(evaluationTime).getTime()
      : this.config.evaluationTime
      ? new Date(this.config.evaluationTime).getTime()
      : Date.now();

    // 1. Process point-in-time live facts (sort captured_at DESC to guarantee deterministic latest-wins)
    const facts = [...(this.config.availabilityFacts || [])].sort((a, b) => {
      const aMs = new Date(a.captured_at).getTime();
      const bMs = new Date(b.captured_at).getTime();
      return bMs - aMs;
    });
    const liveEvidenceBySupplier = new Map<string, VehicleAvailabilityEvidence>();
    const unassociatedLive: VehicleAvailabilityEvidence[] = [];

    for (const fact of facts) {
      if (
        fact.warehouse_id === warehouseId &&
        (!vehicleClass || fact.vehicle_class.toUpperCase() === vehicleClass.toUpperCase())
      ) {
        // Skip superseded facts: only CURRENT unsuperseded assertions participate in live evaluation
        if (fact.superseded_at) {
          continue;
        }

        const { status: availStatus, available } = computeAvailabilityStatus(
          fact.available_count,
          fact.earliest_available_at,
          fact.valid_until,
          evalMs
        );

        const ev: VehicleAvailabilityEvidence = {
          warehouse_id: warehouseId,
          vehicle_id: null,
          vehicle_class: fact.vehicle_class,
          available,
          availability_status: availStatus,
          available_at: fact.earliest_available_at ?? null,
          remaining_capacity_kg: null,
          source_ref: fact.source_ref,
          captured_at: fact.captured_at,
          evidence_status: availStatus === "UNKNOWN" ? "UNKNOWN" : fact.evidence_status,
          supplier_name: fact.supplier_name,
          available_count: fact.available_count,
          earliest_available_at: fact.earliest_available_at ?? null,
          valid_until: fact.valid_until,
          supplied_by: fact.supplied_by,
          supplier_role: fact.supplier_role,
          superseded_at: fact.superseded_at ?? null,
          superseded_by: fact.superseded_by ?? null,
          supersedes_fact_id: fact.supersedes_fact_id ?? null,
          supersession_reason: fact.supersession_reason ?? null,
          is_superseded: false,
        };

        if (fact.supplier_name) {
          const supKey = fact.supplier_name.toUpperCase();
          // Deterministic latest-wins: rows sorted captured_at DESC.
          // The first (newest) unsuperseded assertion is recorded; older rows never overwrite it.
          if (!liveEvidenceBySupplier.has(supKey)) {
            liveEvidenceBySupplier.set(supKey, ev);
          }
        } else {
          unassociatedLive.push(ev);
        }
      }
    }

    // 2. Process recurring schedules
    const schedules = this.config.schedules || [];
    const schedEvidenceBySupplier = new Map<string, VehicleAvailabilityEvidence>();

    for (const sched of schedules) {
      if (
        sched.warehouse_id === warehouseId &&
        (!vehicleClass || sched.vehicle_class.toUpperCase() === vehicleClass.toUpperCase())
      ) {
        const ev = evaluateScheduleEvidence(sched, evalMs, warehouseId, vehicleClass || sched.vehicle_class);
        if (ev && sched.supplier_name) {
          schedEvidenceBySupplier.set(sched.supplier_name.toUpperCase(), ev);
        }
      }
    }

    // 3. Combine with deterministic precedence:
    // Priority 1: Fresh live fact (availability_status !== "UNKNOWN")
    // Priority 2: Recurring schedule
    // Priority 3: Expired live fact
    const allSuppliers = new Set<string>([
      ...liveEvidenceBySupplier.keys(),
      ...schedEvidenceBySupplier.keys(),
    ]);

    const results: VehicleAvailabilityEvidence[] = [];

    for (const supKey of allSuppliers) {
      const liveEv = liveEvidenceBySupplier.get(supKey);
      const schedEv = schedEvidenceBySupplier.get(supKey);

      if (liveEv && liveEv.availability_status !== "UNKNOWN") {
        results.push(liveEv);
      } else if (schedEv) {
        results.push(schedEv);
      } else if (liveEv) {
        results.push(liveEv);
      }
    }

    results.push(...unassociatedLive);

    // 4. Fallback to legacy availabilities if no facts or schedules
    if (results.length === 0 && this.config.availabilities) {
      for (const a of this.config.availabilities) {
        if (
          a.warehouse_id === warehouseId &&
          (!vehicleClass || a.vehicle_class.toUpperCase() === vehicleClass.toUpperCase())
        ) {
          const { status: availStatus, available } = computeAvailabilityStatus(
            a.available_count,
            a.earliest_available_at || a.available_at,
            a.valid_until,
            evalMs,
            a.available
          );

          results.push({
            warehouse_id: a.warehouse_id,
            vehicle_id: a.vehicle_id ?? null,
            vehicle_class: a.vehicle_class,
            available,
            availability_status: availStatus,
            available_at: a.available_at ?? null,
            remaining_capacity_kg: a.remaining_capacity_kg ?? null,
            source_ref: a.source_ref,
            captured_at: a.captured_at ?? null,
            evidence_status: availStatus === "UNKNOWN" ? "UNKNOWN" : (a.evidence_status || "GOVERNED"),
            supplier_name: a.supplier_name ?? null,
            available_count: a.available_count ?? (available === true ? 1 : 0),
            earliest_available_at: a.earliest_available_at ?? a.available_at ?? null,
            valid_until: a.valid_until ?? null,
            supplied_by: a.supplied_by ?? null,
            supplier_role: a.supplier_role ?? null,
          });
        }
      }
    }

    return results;
  }

  private getInMemoryAvailability(
    warehouseId: string,
    vehicleClass = "TRUCK_1_9T",
    supplierName?: string,
    evaluationTime?: string | number | Date
  ): VehicleAvailabilityEvidence {
    const all = this.getInMemoryAvailabilities(warehouseId, vehicleClass, evaluationTime);
    if (supplierName) {
      const match = all.find(
        (a) => a.supplier_name && a.supplier_name.toUpperCase() === supplierName.toUpperCase()
      );
      if (match) return match;
      return {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: vehicleClass,
        available: null,
        availability_status: "UNKNOWN",
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
        supplier_name: supplierName,
      };
    }
    return (
      all[0] || {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: vehicleClass,
        available: null,
        availability_status: "UNKNOWN",
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
        supplier_name: supplierName || null,
      }
    );
  }

  private async queryDbEvidence(
    warehouseId: string,
    vehicleClass?: string,
    evaluationTime?: string | number | Date
  ): Promise<VehicleEconomicsAndCapacityResult> {
    const availabilities = await this.queryDbAvailabilities(warehouseId, vehicleClass, evaluationTime);
    const availability = availabilities[0] || (await this.queryDbAvailability(warehouseId, vehicleClass, undefined, evaluationTime));
    let targetClass = vehicleClass || availability.vehicle_class;
    if (!targetClass) {
      try {
        const { data: rateRows } = await this.config.db!
          .from("governed_vehicle_rates")
          .select("vehicle_class")
          .eq("warehouse_id", warehouseId)
          .is("expires_at", null)
          .limit(1);
        if (rateRows && rateRows.length > 0 && rateRows[0].vehicle_class) {
          targetClass = rateRows[0].vehicle_class;
        }
      } catch {
        // Fallback to default
      }
    }
    if (!targetClass) {
      targetClass = "TRUCK_1_9T";
    }

    const [rates, capacity] = await Promise.all([
      this.queryDbRates(warehouseId, targetClass),
      this.queryDbCapacity(targetClass),
    ]);
    const rate = rates.find((r) => r.warehouse_or_scope === warehouseId) || rates[0] || {
      vehicle_class: targetClass,
      warehouse_or_scope: warehouseId,
      route_or_area: null,
      rate_vnd: null,
      rate_basis: null,
      source_ref: null,
      effective_at: null,
      evidence_status: "UNKNOWN" as const,
      is_stale: false,
    };

    return {
      rate,
      rates,
      capacity,
      availability,
      availabilities,
    };
  }
}
