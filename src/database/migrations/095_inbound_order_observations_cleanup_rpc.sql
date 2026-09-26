-- Migration 095: Inbound order observations scoped cleanup RPC
-- Purpose:
--   Provide a fail-closed, narrowly scoped cleanup function for replacing incomplete
--   inbound order observation populations without granting unrestricted table-level
--   DELETE privileges to application roles.
--
-- Invariants:
--   1. SECURITY DEFINER with fixed search_path = '' (hardened empty search path).
--   2. Fully qualified object names: pg_catalog functions, public.inbound_order_observations.
--   3. Predicate strictly limited to (sync_run_id = p_sync_run_id AND source_system = p_source_system).
--   4. Fixed DELETE statement only — no dynamic SQL, no arbitrary predicates.
--   5. Returns exact count of deleted rows.
--   6. Granted exclusively to service_role; PUBLIC, anon, and authenticated are REVOKED.
--   7. Pure DDL infrastructure capability: NO data mutations, NO cron changes, NO sync run updates.

CREATE OR REPLACE FUNCTION public.clear_inbound_order_observation_population(
  p_sync_run_id UUID,
  p_source_system TEXT DEFAULT 'RILLNET'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted_count INTEGER := 0;
BEGIN
  IF p_sync_run_id IS NULL OR pg_catalog.coalesce(pg_catalog.trim(p_source_system), '') = '' THEN
    RAISE EXCEPTION 'INVALID_CLEANUP_PARAMETERS: sync_run_id and source_system are required';
  END IF;

  WITH deleted AS (
    DELETE FROM public.inbound_order_observations
    WHERE sync_run_id = p_sync_run_id
      AND source_system = p_source_system
    RETURNING id
  )
  SELECT pg_catalog.count(*)::INTEGER INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_inbound_order_observation_population(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_inbound_order_observation_population(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.clear_inbound_order_observation_population(UUID, TEXT) IS
  'Scoped atomic cleanup of incomplete inbound observation populations by sync_run_id and source_system. Executable only by service_role.';
