-- Migration 081: Vehicle Fleet Availability Supplier, Count & Actor Provenance Extension
-- Gate: Level C Gate 3D.1A
-- Purpose:
--   1. Add supplier_name to public.vehicle_fleet_availability to support supplier-specific availability facts.
--   2. Add available_count to public.vehicle_fleet_availability to support explicit vehicle quantity.
--   3. Add supplied_by and supplier_role to persist verified operational actor provenance.
--   4. Add constraint enforcing positive count has valid timing: available_at IS NOT NULL AND available_at <= valid_until.
--   5. Create compound index for fast lookup of active availability facts per warehouse, vehicle class, and supplier.
--   6. Reaffirm least-privilege security: RLS enabled and strictly restricted to service_role only.

-- 1. Add columns
ALTER TABLE public.vehicle_fleet_availability
  ADD COLUMN IF NOT EXISTS supplier_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS available_count INTEGER NULL,
  ADD COLUMN IF NOT EXISTS supplied_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS supplier_role TEXT NULL;

-- 2. Constraints
ALTER TABLE public.vehicle_fleet_availability
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_count_non_negative,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_supplier_not_empty,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_positive_count_time;

ALTER TABLE public.vehicle_fleet_availability
  ADD CONSTRAINT chk_fleet_avail_count_non_negative
    CHECK (available_count IS NULL OR available_count >= 0),
  ADD CONSTRAINT chk_fleet_avail_supplier_not_empty
    CHECK (supplier_name IS NULL OR length(trim(supplier_name)) > 0),
  ADD CONSTRAINT chk_fleet_avail_positive_count_time
    CHECK (
      available_count IS NULL OR
      available_count = 0 OR
      (available_count > 0 AND available_at IS NOT NULL AND available_at <= valid_until)
    );

-- 3. Lookup Index
CREATE INDEX IF NOT EXISTS idx_fleet_avail_supplier_lookup
  ON public.vehicle_fleet_availability (warehouse_id, vehicle_class, supplier_name, captured_at DESC);

-- 4. Reaffirm Row Level Security (RLS)
ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access on vehicle_fleet_availability" ON public.vehicle_fleet_availability;
CREATE POLICY "Allow service role full access on vehicle_fleet_availability"
  ON public.vehicle_fleet_availability FOR ALL TO service_role USING (true) WITH CHECK (true);

