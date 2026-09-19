-- Migration 085B: Fix RPC Execution Order and Tighten Permissions
-- Gate: Level C Gate 3D.4 Phase 2B Remediation
-- Purpose:
--   1. Make fk_fleet_avail_superseded_by DEFERRABLE INITIALLY DEFERRED
--   2. Fix statement execution order in replace_vehicle_availability_fact:
--      supersede old row -> insert new row -> link superseded_by
--   3. Explicitly REVOKE EXECUTE from PUBLIC, anon, authenticated; GRANT to service_role only.

-- 1. Foreign key constraint deferral
ALTER TABLE public.vehicle_fleet_availability
  DROP CONSTRAINT IF EXISTS fk_fleet_avail_superseded_by;

ALTER TABLE public.vehicle_fleet_availability
  ADD CONSTRAINT fk_fleet_avail_superseded_by
  FOREIGN KEY (superseded_by) REFERENCES public.vehicle_fleet_availability(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- 2. Fixed RPC
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
  -- Validate boolean consistency according to constraint
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

    -- Step 1: Mark prior current fact as superseded without setting superseded_by yet
    -- This unblocks the partial unique index uq_fleet_avail_single_current
    UPDATE public.vehicle_fleet_availability
    SET superseded_at = p_captured_at,
        supersession_reason = p_supersession_reason,
        updated_at = NOW()
    WHERE id = v_old_row.id;
  END IF;

  -- Step 2: Insert the new CURRENT fact
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

  -- Step 3: Link prior fact to new fact now that new fact exists
  IF v_superseded_id IS NOT NULL THEN
    UPDATE public.vehicle_fleet_availability
    SET superseded_by = v_new_id
    WHERE id = v_superseded_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_new_id,
    'superseded_id', v_superseded_id
  );
END;
$$;

-- 3. Revoke permissions from PUBLIC, anon, authenticated; Grant only to service_role
REVOKE ALL ON FUNCTION public.replace_vehicle_availability_fact(text, text, text, integer, timestamptz, timestamptz, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_vehicle_availability_fact(text, text, text, integer, timestamptz, timestamptz, timestamptz, text, text, text, text) TO service_role;
