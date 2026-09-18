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

export type VehicleAvailabilityEvidenceStatus = "MEASURED" | "GOVERNED" | "OWNER_CONFIRMED" | "MODELED" | "UNKNOWN";

export interface VehicleAvailabilityEvidence {
  warehouse_id: string;
  vehicle_id: string | null;
  vehicle_class: string | null;
  available: boolean | null;
  available_at: string | null;
  remaining_capacity_kg: number | null;
  source_ref: string | null;
  captured_at: string | null;
  evidence_status: VehicleAvailabilityEvidenceStatus;
}

export interface VehicleEconomicsAndCapacityResult {
  rate: VehicleRateEvidence;
  rates?: VehicleRateEvidence[];
  capacity: VehicleCapacityEvidence;
  availability: VehicleAvailabilityEvidence;
}

export interface VehicleSourceAdapter {
  getVehicleRate(warehouseId: string, vehicleClass?: string, supplierName?: string): Promise<VehicleRateEvidence> | VehicleRateEvidence;
  getVehicleRates?(warehouseId: string, vehicleClass?: string): Promise<VehicleRateEvidence[]> | VehicleRateEvidence[];
  getVehicleCapacity(vehicleClass?: string): Promise<VehicleCapacityEvidence> | VehicleCapacityEvidence;
  getVehicleAvailability(warehouseId: string): Promise<VehicleAvailabilityEvidence> | VehicleAvailabilityEvidence;
  getVehicleEvidence(warehouseId: string, vehicleClass?: string): Promise<VehicleEconomicsAndCapacityResult> | VehicleEconomicsAndCapacityResult;
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
  vehicle_id: string;
  vehicle_class: string;
  available: boolean;
  available_at?: string;
  remaining_capacity_kg?: number;
  source_ref: string;
  captured_at?: string;
  valid_until?: string;
}

export interface GovernedVehicleSourceConfig {
  db?: SupabaseClient;
  rates?: GovernedRateRecord[];
  capacities?: Record<string, GovernedCapacityRecord>;
  availabilities?: GovernedAvailabilityRecord[];
  maxRateAgeDays?: number;
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

  getVehicleAvailability(warehouseId: string): any {
    if (this.config.db) {
      return this.queryDbAvailability(warehouseId);
    }
    return this.getInMemoryAvailability(warehouseId);
  }

  getVehicleEvidence(warehouseId: string, vehicleClass?: string): any {
    if (this.config.db) {
      return this.queryDbEvidence(warehouseId, vehicleClass);
    }

    const availability = this.getInMemoryAvailability(warehouseId);
    const targetClass = vehicleClass || availability.vehicle_class || "STANDARD_EXTERNAL_TRUCK";
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

  private async queryDbAvailability(warehouseId: string): Promise<VehicleAvailabilityEvidence> {
    try {
      const { data, error } = await this.config.db!
        .from("vehicle_fleet_availability")
        .select("*")
        .eq("warehouse_id", warehouseId)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        return {
          warehouse_id: warehouseId,
          vehicle_id: null,
          vehicle_class: null,
          available: null,
          available_at: null,
          remaining_capacity_kg: null,
          source_ref: null,
          captured_at: null,
          evidence_status: "UNKNOWN",
        };
      }

      const now = Date.now();
      const validUntilTime = new Date(data.valid_until).getTime();
      const isExpired = now > validUntilTime;

      if (isExpired) {
        return {
          warehouse_id: warehouseId,
          vehicle_id: data.vehicle_id,
          vehicle_class: data.vehicle_class,
          available: null,
          available_at: null,
          remaining_capacity_kg: null,
          source_ref: data.source_ref,
          captured_at: data.captured_at,
          evidence_status: "UNKNOWN",
        };
      }

      return {
        warehouse_id: data.warehouse_id,
        vehicle_id: data.vehicle_id,
        vehicle_class: data.vehicle_class,
        available: Boolean(data.available),
        available_at: data.available_at ?? null,
        remaining_capacity_kg: data.remaining_capacity_kg != null ? Number(data.remaining_capacity_kg) : null,
        source_ref: data.source_ref,
        captured_at: data.captured_at,
        evidence_status: "GOVERNED",
      };
    } catch {
      return {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: null,
        available: null,
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
      };
    }
  }

  private getInMemoryAvailability(warehouseId: string): VehicleAvailabilityEvidence {
    const availabilities = this.config.availabilities || [];
    const matched = availabilities.find((a) => a.warehouse_id === warehouseId);

    if (!matched) {
      return {
        warehouse_id: warehouseId,
        vehicle_id: null,
        vehicle_class: null,
        available: null,
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
      };
    }

    if (matched.valid_until) {
      const now = Date.now();
      const validUntilTime = new Date(matched.valid_until).getTime();
      if (now > validUntilTime) {
        return {
          warehouse_id: warehouseId,
          vehicle_id: matched.vehicle_id,
          vehicle_class: matched.vehicle_class,
          available: null,
          available_at: null,
          remaining_capacity_kg: null,
          source_ref: matched.source_ref,
          captured_at: matched.captured_at ?? null,
          evidence_status: "UNKNOWN",
        };
      }
    }

    return {
      warehouse_id: matched.warehouse_id,
      vehicle_id: matched.vehicle_id,
      vehicle_class: matched.vehicle_class,
      available: matched.available,
      available_at: matched.available_at ?? null,
      remaining_capacity_kg: matched.remaining_capacity_kg ?? null,
      source_ref: matched.source_ref,
      captured_at: matched.captured_at ?? null,
      evidence_status: "GOVERNED",
    };
  }

  private async queryDbEvidence(warehouseId: string, vehicleClass?: string): Promise<VehicleEconomicsAndCapacityResult> {
    const availability = await this.queryDbAvailability(warehouseId);
    const targetClass = vehicleClass || availability.vehicle_class || "STANDARD_EXTERNAL_TRUCK";
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
    };
  }
}
