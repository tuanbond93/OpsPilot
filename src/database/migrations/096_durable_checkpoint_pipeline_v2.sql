-- Migration 096: Durable Checkpoint Pipeline V2
-- Establishes partitioned, lease-managed work queues and effectively-once dispatch ledgers
-- to ensure checkpoint processing scales by work units, not serverless invocation runtime.

BEGIN;

CREATE TABLE IF NOT EXISTS public.checkpoint_work_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_at TIMESTAMPTZ NOT NULL,
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN (
    'CREATED', 'INGESTING', 'INGESTION_COMPLETE',
    'FOLLOWUPS_PENDING', 'FOLLOWUPS_PROCESSING', 'FOLLOWUPS_COMPLETE',
    'DISPATCH_PENDING', 'DISPATCH_PROCESSING', 'COMPLETE',
    'FAILED_RETRYABLE', 'FAILED_TERMINAL'
  )),
  work_type TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_mode TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (execution_mode IN ('PRODUCTION', 'SHADOW')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'LEASED', 'COMPLETED', 'FAILED')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 3,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  failure_code TEXT NULL,
  last_safe_error TEXT NULL,
  retry_after TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_work_units_claim
  ON public.checkpoint_work_units (checkpoint_at, execution_mode, status, retry_after, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_checkpoint_work_units_sync_run
  ON public.checkpoint_work_units (sync_run_id);

CREATE TABLE IF NOT EXISTS public.checkpoint_dispatch_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_at TIMESTAMPTZ NOT NULL,
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES public.followup_cases(id) ON DELETE CASCADE,
  incident_key TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  sequence INT NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  execution_mode TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (execution_mode IN ('PRODUCTION', 'SHADOW')),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'DISPATCHED', 'CONFIRMED', 'FAILED')),
  telegram_message_id TEXT NULL,
  payload_summary JSONB NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  dispatched_at TIMESTAMPTZ NULL,
  confirmed_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_dispatch_ledger_checkpoint
  ON public.checkpoint_dispatch_ledger (checkpoint_at, status);

-- Atomic lease acquisition for checkpoint work units with skip locked
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

ALTER TABLE public.checkpoint_work_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_dispatch_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.checkpoint_work_units FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.checkpoint_dispatch_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.checkpoint_work_units TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.checkpoint_dispatch_ledger TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT) TO service_role;

COMMIT;
