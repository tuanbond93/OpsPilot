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

export type VehicleAvailabilityEvidenceStatus =
  | "MEASURED"
  | "GOVERNED"
  | "OWNER_CONFIRMED"
  | "MODELED"
  | "AUTHORIZED_OPERATIONAL_FACT"
  | "UNKNOWN";

export type AuthorizedOperationalRole =
  | "WAREHOUSE_LEAD"
  | "DISPATCH_MANAGER"
  | "OPERATIONS_MANAGER"
  | "LEAD"
  | "MANAGER"
  | "ADMIN";

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
  supplier_name?: string | null;
  available_count?: number | null;
  earliest_available_at?: string | null;
  valid_until?: string | null;
  supplied_by?: string | null;
  supplier_role?: string | null;
}

export interface VehicleAvailabilityFact {
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
  evidence_status: "AUTHORIZED_OPERATIONAL_FACT";
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
  getVehicleAvailability(warehouseId: string, vehicleClass?: string, supplierName?: string): Promise<VehicleAvailabilityEvidence> | VehicleAvailabilityEvidence;
  getVehicleAvailabilities?(warehouseId: string, vehicleClass?: string): Promise<VehicleAvailabilityEvidence[]> | VehicleAvailabilityEvidence[];
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
}

export interface GovernedVehicleSourceConfig {
  db?: SupabaseClient;
  rates?: GovernedRateRecord[];
  capacities?: Record<string, GovernedCapacityRecord>;
  availabilities?: GovernedAvailabilityRecord[];
  availabilityFacts?: VehicleAvailabilityFact[];
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

  getVehicleAvailability(warehouseId: string, vehicleClass?: string, supplierName?: string): any {
    if (this.config.db) {
      return this.queryDbAvailability(warehouseId, vehicleClass, supplierName);
    }
    return this.getInMemoryAvailability(warehouseId, vehicleClass, supplierName);
  }

  getVehicleAvailabilities(warehouseId: string, vehicleClass?: string): any {
    if (this.config.db) {
      return this.queryDbAvailabilities(warehouseId, vehicleClass);
    }
    return this.getInMemoryAvailabilities(warehouseId, vehicleClass);
  }

  getVehicleEvidence(warehouseId: string, vehicleClass?: string): any {
    if (this.config.db) {
      return this.queryDbEvidence(warehouseId, vehicleClass);
    }

    const availabilities = this.getInMemoryAvailabilities(warehouseId, vehicleClass);
    const availability = availabilities[0] || this.getInMemoryAvailability(warehouseId, vehicleClass);
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
    vehicleClass?: string
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

      if (error || !data) {
        return [];
      }

      const rows = Array.isArray(data) ? data : [data];
      if (rows.length === 0) return [];

      const now = Date.now();
      return rows.map((row: any) => {
        const validUntilTime = row.valid_until ? new Date(row.valid_until).getTime() : 0;
        const isExpired = now > validUntilTime;
        const isOperationalFact =
          typeof row.source_ref === "string" &&
          row.source_ref.startsWith("AUTHORIZED_OPERATIONAL_FACT");

        if (isExpired) {
          return {
            warehouse_id: row.warehouse_id,
            vehicle_id: row.vehicle_id ?? null,
            vehicle_class: row.vehicle_class,
            available: null,
            available_at: null,
            remaining_capacity_kg: null,
            source_ref: row.source_ref,
            captured_at: row.captured_at,
            evidence_status: "UNKNOWN" as const,
            supplier_name: row.supplier_name ?? null,
            available_count: row.available_count ?? null,
            valid_until: row.valid_until ?? null,
          };
        }

        const isAvail =
          row.available_count !== undefined && row.available_count !== null
            ? row.available_count > 0
            : Boolean(row.available);

        return {
          warehouse_id: row.warehouse_id,
          vehicle_id: row.vehicle_id ?? null,
          vehicle_class: row.vehicle_class,
          available: isAvail,
          available_at: row.available_at ?? null,
          remaining_capacity_kg: row.remaining_capacity_kg != null ? Number(row.remaining_capacity_kg) : null,
          source_ref: row.source_ref,
          captured_at: row.captured_at,
          evidence_status: isOperationalFact
            ? ("AUTHORIZED_OPERATIONAL_FACT" as const)
            : ("GOVERNED" as const),
          supplier_name: row.supplier_name ?? null,
          available_count: row.available_count ?? (row.available ? 1 : 0),
          valid_until: row.valid_until ?? null,
        };
      });
    } catch {
      return [];
    }
  }

  private async queryDbAvailability(
    warehouseId: string,
    vehicleClass?: string,
    supplierName?: string
  ): Promise<VehicleAvailabilityEvidence> {
    const all = await this.queryDbAvailabilities(warehouseId, vehicleClass);
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
    vehicleClass?: string
  ): VehicleAvailabilityEvidence[] {
    const now = Date.now();
    const results: VehicleAvailabilityEvidence[] = [];

    // 1. Check availabilityFacts (highest priority in Gate 3D.1)
    const facts = this.config.availabilityFacts || [];
    for (const fact of facts) {
      if (
        fact.warehouse_id === warehouseId &&
        (!vehicleClass || fact.vehicle_class.toUpperCase() === vehicleClass.toUpperCase())
      ) {
        const validUntilMs = new Date(fact.valid_until).getTime();
        const isExpired = now > validUntilMs;
        if (isExpired) {
          results.push({
            warehouse_id: warehouseId,
            vehicle_id: null,
            vehicle_class: fact.vehicle_class,
            available: null,
            available_at: null,
            remaining_capacity_kg: null,
            source_ref: fact.source_ref,
            captured_at: fact.captured_at,
            evidence_status: "UNKNOWN",
            supplier_name: fact.supplier_name,
            available_count: fact.available_count,
            earliest_available_at: fact.earliest_available_at ?? null,
            valid_until: fact.valid_until,
            supplied_by: fact.supplied_by,
            supplier_role: fact.supplier_role,
          });
        } else {
          const isAvail = fact.available_count > 0;
          results.push({
            warehouse_id: warehouseId,
            vehicle_id: null,
            vehicle_class: fact.vehicle_class,
            available: isAvail,
            available_at: fact.earliest_available_at ?? null,
            remaining_capacity_kg: null,
            source_ref: fact.source_ref,
            captured_at: fact.captured_at,
            evidence_status: "AUTHORIZED_OPERATIONAL_FACT",
            supplier_name: fact.supplier_name,
            available_count: fact.available_count,
            earliest_available_at: fact.earliest_available_at ?? null,
            valid_until: fact.valid_until,
            supplied_by: fact.supplied_by,
            supplier_role: fact.supplier_role,
          });
        }
      }
    }

    // 2. Check legacy / governed availabilities
    const availabilities = this.config.availabilities || [];
    for (const a of availabilities) {
      if (
        a.warehouse_id === warehouseId &&
        (!vehicleClass || a.vehicle_class.toUpperCase() === vehicleClass.toUpperCase())
      ) {
        const validUntilMs = a.valid_until ? new Date(a.valid_until).getTime() : Infinity;
        const isExpired = now > validUntilMs;
        const status = a.evidence_status || (isExpired ? "UNKNOWN" : "GOVERNED");
        results.push({
          warehouse_id: a.warehouse_id,
          vehicle_id: a.vehicle_id ?? null,
          vehicle_class: a.vehicle_class,
          available: isExpired ? null : Boolean(a.available),
          available_at: a.available_at ?? null,
          remaining_capacity_kg: a.remaining_capacity_kg ?? null,
          source_ref: a.source_ref,
          captured_at: a.captured_at ?? null,
          evidence_status: status,
          supplier_name: a.supplier_name ?? null,
          available_count: a.available_count ?? (a.available ? 1 : 0),
          earliest_available_at: a.earliest_available_at ?? a.available_at ?? null,
          valid_until: a.valid_until ?? null,
          supplied_by: a.supplied_by ?? null,
          supplier_role: a.supplier_role ?? null,
        });
      }
    }

    return results;
  }

  private getInMemoryAvailability(
    warehouseId: string,
    vehicleClass = "TRUCK_1_9T",
    supplierName?: string
  ): VehicleAvailabilityEvidence {
    const all = this.getInMemoryAvailabilities(warehouseId, vehicleClass);
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
        available_at: null,
        remaining_capacity_kg: null,
        source_ref: null,
        captured_at: null,
        evidence_status: "UNKNOWN",
        supplier_name: supplierName || null,
      }
    );
  }

  private async queryDbEvidence(warehouseId: string, vehicleClass?: string): Promise<VehicleEconomicsAndCapacityResult> {
    const availabilities = await this.queryDbAvailabilities(warehouseId, vehicleClass);
    const availability = availabilities[0] || (await this.queryDbAvailability(warehouseId, vehicleClass));
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
