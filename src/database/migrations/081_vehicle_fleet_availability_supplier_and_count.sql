-- Migration 081: Vehicle Fleet Availability Supplier, Count, Actor Provenance & Consistency Hardening
-- Gate: Level C Gate 3D.1B
-- Purpose:
--   1. Add supplier_name, available_count, supplied_by, and supplier_role to public.vehicle_fleet_availability.
--   2. Add boolean consistency constraint: available == (available_count > 0 AND available_at <= captured_at).
--   3. Add provenance constraint: AUTHORIZED_OPERATIONAL_FACT requires human operational roles; SYSTEM_AUTHORIZED_IMPORT requires SYSTEM_ADMIN.
--   4. Add role validity constraint: only WAREHOUSE_LEAD, OPERATIONS_MANAGER, DISPATCH_MANAGER, SYSTEM_ADMIN, or NULL.
--   5. Add count metadata constraint: supplier_name, source_ref, captured_at, valid_until required when available_count IS NOT NULL.
--   6. Enforce positive count timing: available_at IS NOT NULL AND available_at <= valid_until.
--   7. Compound index for fast lookup of active availability facts per warehouse, vehicle class, and supplier.
--   8. Reaffirm least-privilege security: RLS enabled and strictly restricted to service_role only.

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
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_positive_count_time,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_boolean_consistency,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_role_valid,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_provenance,
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_count_metadata;

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
    ),
  ADD CONSTRAINT chk_fleet_avail_boolean_consistency
    CHECK (
      available_count IS NULL OR
      available = (available_count > 0 AND available_at IS NOT NULL AND available_at <= captured_at)
    ),
  ADD CONSTRAINT chk_fleet_avail_role_valid
    CHECK (
      supplier_role IS NULL OR
      supplier_role IN ('WAREHOUSE_LEAD', 'OPERATIONS_MANAGER', 'DISPATCH_MANAGER', 'SYSTEM_ADMIN')
    ),
  ADD CONSTRAINT chk_fleet_avail_provenance
    CHECK (
      (
        source_ref NOT LIKE 'AUTHORIZED_OPERATIONAL_FACT:%' OR (
          supplier_name IS NOT NULL AND length(trim(supplier_name)) > 0 AND
          supplied_by IS NOT NULL AND length(trim(supplied_by)) > 0 AND
          supplier_role IS NOT NULL AND
          supplier_role IN ('WAREHOUSE_LEAD', 'OPERATIONS_MANAGER', 'DISPATCH_MANAGER')
        )
      )
      AND
      (
        source_ref NOT LIKE 'SYSTEM_AUTHORIZED_IMPORT:%' OR (
          supplier_role IS NOT NULL AND
          supplier_role = 'SYSTEM_ADMIN'
        )
      )
    ),
  ADD CONSTRAINT chk_fleet_avail_count_metadata
    CHECK (
      available_count IS NULL OR (
        supplier_name IS NOT NULL AND length(trim(supplier_name)) > 0 AND
        source_ref IS NOT NULL AND length(trim(source_ref)) > 0 AND
        captured_at IS NOT NULL AND
        valid_until IS NOT NULL
      )
    );

-- 3. Lookup Index
CREATE INDEX IF NOT EXISTS idx_fleet_avail_supplier_lookup
  ON public.vehicle_fleet_availability (warehouse_id, vehicle_class, supplier_name, captured_at DESC);

-- 4. Reaffirm Row Level Security (RLS)
ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access on vehicle_fleet_availability" ON public.vehicle_fleet_availability;
CREATE POLICY "Allow service role full access on vehicle_fleet_availability"
  ON public.vehicle_fleet_availability FOR ALL TO service_role USING (true) WITH CHECK (true);
