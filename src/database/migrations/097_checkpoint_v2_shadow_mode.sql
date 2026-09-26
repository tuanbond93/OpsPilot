-- Migration 097: Checkpoint V2 Shadow Mode Isolation
-- Adds explicit durable execution_mode ('PRODUCTION' | 'SHADOW') to checkpoint_work_units
-- and checkpoint_dispatch_ledger, and updates claim_checkpoint_work_units to filter by execution_mode.

BEGIN;

ALTER TABLE public.checkpoint_work_units
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PRODUCTION'
  CHECK (execution_mode IN ('PRODUCTION', 'SHADOW'));

ALTER TABLE public.checkpoint_dispatch_ledger
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PRODUCTION'
  CHECK (execution_mode IN ('PRODUCTION', 'SHADOW'));

CREATE INDEX IF NOT EXISTS idx_checkpoint_work_units_claim_mode
  ON public.checkpoint_work_units (checkpoint_at, execution_mode, status, retry_after, lease_expires_at);

-- Update claim RPC with p_execution_mode
CREATE OR REPLACE FUNCTION public.claim_checkpoint_work_units(
  p_checkpoint_at TIMESTAMPTZ,
  p_worker_id TEXT,
  p_lease_seconds INT,
  p_limit INT,
  p_execution_mode TEXT DEFAULT 'PRODUCTION'
)
RETURNS SETOF public.checkpoint_work_units
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_lease_expiry TIMESTAMPTZ := v_now + make_interval(secs => p_lease_seconds);
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.checkpoint_work_units
    WHERE checkpoint_at = p_checkpoint_at
      AND execution_mode = p_execution_mode
      AND (
        (status = 'PENDING' AND (retry_after IS NULL OR retry_after <= v_now))
        OR (status = 'LEASED' AND lease_expires_at <= v_now)
      )
      AND attempts < max_attempts
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.checkpoint_work_units w
  SET status = 'LEASED',
      lease_owner = p_worker_id,
      lease_expires_at = v_lease_expiry,
      started_at = coalesce(w.started_at, v_now),
      attempts = w.attempts + 1,
      updated_at = v_now
  FROM claimable
  WHERE w.id = claimable.id
  RETURNING w.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT) TO service_role;

COMMIT;
