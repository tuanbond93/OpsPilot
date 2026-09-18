-- Migration 078: Governed Vehicle Source Infrastructure
-- Establishes authoritative, read-only relational storage for vehicle rates, classes/capacity, and fleet availability.
-- Strictly unseeded: No operational data is fabricated or inferred from vehicle names.
-- Read-only to ordinary runtime: Only service role / admin may insert governed contracts.

-- 1. Governed Vehicle Classes (Group B: Vehicle Capacity)
CREATE TABLE IF NOT EXISTS public.governed_vehicle_classes (
  vehicle_class TEXT PRIMARY KEY,
  max_payload_kg NUMERIC NOT NULL,
  usable_payload_kg NUMERIC NULL,
  volume_m3 NUMERIC NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  source_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vehicle_class_name CHECK (length(trim(vehicle_class)) > 0),
  CONSTRAINT chk_vehicle_class_payload_non_negative CHECK (max_payload_kg >= 0 AND (usable_payload_kg IS NULL OR usable_payload_kg >= 0) AND (volume_m3 IS NULL OR volume_m3 >= 0)),
  CONSTRAINT chk_vehicle_class_expiry CHECK (expires_at IS NULL OR expires_at > effective_at),
  CONSTRAINT chk_vehicle_class_source_ref CHECK (length(trim(source_ref)) > 0)
);

-- 2. Governed Vehicle Rates (Group A: Vehicle Rates & Economics)
CREATE TABLE IF NOT EXISTS public.governed_vehicle_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  route_or_area TEXT NULL,
  rate_vnd BIGINT NOT NULL,
  rate_basis TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  contract_ref TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  supplier_name TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vehicle_rate_warehouse_id CHECK (length(trim(warehouse_id)) > 0),
  CONSTRAINT chk_vehicle_rate_class CHECK (length(trim(vehicle_class)) > 0),
  CONSTRAINT chk_vehicle_rate_vnd_non_negative CHECK (rate_vnd >= 0),
  CONSTRAINT chk_vehicle_rate_basis CHECK (rate_basis IN ('TRIP', 'DAY', 'HOUR', 'KG')),
  CONSTRAINT chk_vehicle_rate_expiry CHECK (expires_at IS NULL OR expires_at > effective_at),
  CONSTRAINT chk_vehicle_rate_contract_ref CHECK (length(trim(contract_ref)) > 0),
  CONSTRAINT chk_vehicle_rate_source_ref CHECK (length(trim(source_ref)) > 0),
  CONSTRAINT fk_governed_vehicle_rates_class FOREIGN KEY (vehicle_class) REFERENCES public.governed_vehicle_classes(vehicle_class) ON DELETE RESTRICT
);

-- 3. Vehicle Fleet Availability (Group C: Fleet Telemetry & Availability)
CREATE TABLE IF NOT EXISTS public.vehicle_fleet_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id TEXT NOT NULL,
  vehicle_id TEXT NULL,
  vehicle_class TEXT NOT NULL,
  available BOOLEAN NOT NULL,
  available_at TIMESTAMPTZ NULL,
  remaining_capacity_kg NUMERIC NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fleet_avail_warehouse_id CHECK (length(trim(warehouse_id)) > 0),
  CONSTRAINT chk_fleet_avail_class CHECK (length(trim(vehicle_class)) > 0),
  CONSTRAINT chk_fleet_avail_capacity_non_negative CHECK (remaining_capacity_kg IS NULL OR remaining_capacity_kg >= 0),
  CONSTRAINT chk_fleet_avail_valid_until CHECK (valid_until >= captured_at),
  CONSTRAINT chk_fleet_avail_source_ref CHECK (length(trim(source_ref)) > 0),
  CONSTRAINT fk_vehicle_fleet_avail_class FOREIGN KEY (vehicle_class) REFERENCES public.governed_vehicle_classes(vehicle_class) ON DELETE RESTRICT
);

-- Indexes
-- Prevent ambiguous overlapping active rates for the same warehouse, vehicle class, and route/area
CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_rate_active_scope
  ON public.governed_vehicle_rates (warehouse_id, vehicle_class, COALESCE(route_or_area, 'GLOBAL'))
  WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_governed_rates_lookup
  ON public.governed_vehicle_rates (warehouse_id, vehicle_class, effective_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_avail_lookup
  ON public.vehicle_fleet_availability (warehouse_id, vehicle_class, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_avail_valid_until
  ON public.vehicle_fleet_availability (warehouse_id, valid_until DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.governed_vehicle_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governed_vehicle_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;

-- Read policies for authenticated application users
CREATE POLICY "Allow authenticated read on governed_vehicle_classes"
  ON public.governed_vehicle_classes FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated read on governed_vehicle_rates"
  ON public.governed_vehicle_rates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated read on vehicle_fleet_availability"
  ON public.vehicle_fleet_availability FOR SELECT TO authenticated USING (true);

-- Admin / Service Role full access policies
CREATE POLICY "Allow service role full access on governed_vehicle_classes"
  ON public.governed_vehicle_classes FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on governed_vehicle_rates"
  ON public.governed_vehicle_rates FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on vehicle_fleet_availability"
  ON public.vehicle_fleet_availability FOR ALL TO service_role USING (true) WITH CHECK (true);
