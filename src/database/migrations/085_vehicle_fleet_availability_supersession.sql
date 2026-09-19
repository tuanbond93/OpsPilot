-- Migration 085: Vehicle Fleet Availability Lifecycle Supersession & Atomic Correction Path
-- Gate: Level C Gate 3D.4 Phase 2B
-- Purpose:
--   1. Add lifecycle supersession metadata columns to public.vehicle_fleet_availability:
--      superseded_at, superseded_by, supersedes_fact_id, supersession_reason.
--   2. Establish database invariant ensuring single CURRENT fact per (warehouse_id, vehicle_class, supplier_name).
--   3. Implement atomic RPC public.replace_vehicle_availability_fact to eliminate non-atomic update/insert windows.
--   4. Preserve historical assertions intact (original valid_until preserved).
--   5. Maintain strict service-role execution security for RPC and table writes.

-- 1. Add supersession columns
ALTER TABLE public.vehicle_fleet_availability
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS superseded_by UUID NULL,
  ADD COLUMN IF NOT EXISTS supersedes_fact_id UUID NULL,
  ADD COLUMN IF NOT EXISTS supersession_reason TEXT NULL;

-- 2. Foreign key constraints for audit lineage
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_fleet_avail_superseded_by'
  ) THEN
    ALTER TABLE public.vehicle_fleet_availability
      ADD CONSTRAINT fk_fleet_avail_superseded_by
      FOREIGN KEY (superseded_by) REFERENCES public.vehicle_fleet_availability(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_fleet_avail_supersedes_fact_id'
  ) THEN
    ALTER TABLE public.vehicle_fleet_availability
      ADD CONSTRAINT fk_fleet_avail_supersedes_fact_id
      FOREIGN KEY (supersedes_fact_id) REFERENCES public.vehicle_fleet_availability(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 3. Consistency constraint: superseded_at must be >= captured_at
ALTER TABLE public.vehicle_fleet_availability
  DROP CONSTRAINT IF EXISTS chk_fleet_avail_superseded_consistency;

ALTER TABLE public.vehicle_fleet_availability
  ADD CONSTRAINT chk_fleet_avail_superseded_consistency
    CHECK (superseded_at IS NULL OR superseded_at >= captured_at);

-- 4. DB Invariant: Exactly one CURRENT unsuperseded fact per (warehouse, vehicle_class, supplier)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_avail_single_current
  ON public.vehicle_fleet_availability (warehouse_id, vehicle_class, supplier_name)
  WHERE superseded_at IS NULL;

-- 5. Atomic RPC: replace_vehicle_availability_fact
CREATE OR REPLACE FUNCTION public.replace_vehicle_availability_fact(
  p_warehouse_id TEXT,
  p_supplier_name TEXT,
  p_vehicle_class TEXT,
  p_available_count INTEGER,
  p_available_at TIMESTAMPTZ,
  p_captured_at TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_source_ref TEXT,
  p_supplied_by TEXT,
  p_supplier_role TEXT,
  p_supersession_reason TEXT DEFAULT 'DIRECT_OWNER_CORRECTION'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_row RECORD;
  v_new_id UUID := gen_random_uuid();
  v_is_available BOOLEAN;
  v_superseded_id UUID := NULL;
BEGIN
  -- Validate boolean consistency according to migration 081 constraint
  v_is_available := (p_available_count > 0 AND p_available_at IS NOT NULL AND p_available_at <= p_captured_at);

  -- Lock and read any existing CURRENT unsuperseded fact for this tuple
  SELECT id, captured_at, valid_until
  INTO v_old_row
  FROM public.vehicle_fleet_availability
  WHERE warehouse_id = p_warehouse_id
    AND supplier_name = p_supplier_name
    AND vehicle_class = p_vehicle_class
    AND superseded_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    v_superseded_id := v_old_row.id;

    -- Mark prior current fact as superseded, leaving original valid_until intact
    UPDATE public.vehicle_fleet_availability
    SET superseded_at = p_captured_at,
        superseded_by = v_new_id,
        supersession_reason = p_supersession_reason,
        updated_at = NOW()
    WHERE id = v_old_row.id;
  END IF;

  -- Insert the new CURRENT fact
  INSERT INTO public.vehicle_fleet_availability (
    id,
    warehouse_id,
    supplier_name,
    vehicle_class,
    available,
    available_count,
    available_at,
    captured_at,
    valid_until,
    source_ref,
    supplied_by,
    supplier_role,
    supersedes_fact_id,
    superseded_at,
    superseded_by,
    supersession_reason,
    created_at,
    updated_at
  ) VALUES (
    v_new_id,
    p_warehouse_id,
    p_supplier_name,
    p_vehicle_class,
    v_is_available,
    p_available_count,
    p_available_at,
    p_captured_at,
    p_valid_until,
    p_source_ref,
    p_supplied_by,
    p_supplier_role,
    v_superseded_id,
    NULL,
    NULL,
    NULL,
    NOW(),
    NOW()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_new_id,
    'superseded_id', v_superseded_id
  );
END;
$$;

-- 6. Security Hardening: Least-privilege RPC execution
REVOKE ALL ON FUNCTION public.replace_vehicle_availability_fact FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_vehicle_availability_fact TO service_role;
