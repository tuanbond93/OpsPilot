-- Release B: immutable V1 checkpoint input and retry identity for follow-up events.
-- The existing checkpoint_work_units queue remains the only work queue.
BEGIN;

CREATE TABLE IF NOT EXISTS public.checkpoint_v1_followup_inputs (
  sync_run_id UUID PRIMARY KEY REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  checkpoint_at TIMESTAMPTZ NOT NULL,
  reference_time_ms BIGINT NOT NULL,
  orders JSONB NOT NULL,
  incidents JSONB NOT NULL,
  candidate_keys JSONB NOT NULL,
  input_sha256 TEXT NOT NULL,
  producer_completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkpoint_v1_followup_inputs_orders_array CHECK (jsonb_typeof(orders) = 'array'),
  CONSTRAINT checkpoint_v1_followup_inputs_incidents_array CHECK (jsonb_typeof(incidents) = 'array'),
  CONSTRAINT checkpoint_v1_followup_inputs_candidates_array CHECK (jsonb_typeof(candidate_keys) = 'array')
);

ALTER TABLE public.checkpoint_v1_followup_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkpoint_v1_followup_inputs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.checkpoint_v1_followup_inputs TO service_role;

ALTER TABLE public.followup_events ADD COLUMN IF NOT EXISTS durable_work_key TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_events_durable_work_key
  ON public.followup_events(durable_work_key);

-- Keep the existing five-argument V2 claim intact. V1 uses this scoped
-- overload so a production-mode worker cannot claim another pipeline's unit.
CREATE OR REPLACE FUNCTION public.claim_checkpoint_work_units(
  p_checkpoint_at TIMESTAMPTZ,
  p_worker_id TEXT,
  p_lease_seconds INT,
  p_limit INT,
  p_execution_mode TEXT,
  p_pipeline_version TEXT
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
  IF p_pipeline_version NOT IN ('V1', 'V2') THEN
    RAISE EXCEPTION 'INVALID_PIPELINE_VERSION';
  END IF;
  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.checkpoint_work_units
    WHERE checkpoint_at = p_checkpoint_at
      AND execution_mode = p_execution_mode
      AND cursor #>> '{metadata,pipelineVersion}' = p_pipeline_version
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
  SET status = 'LEASED', lease_owner = p_worker_id,
      lease_expires_at = v_lease_expiry,
      started_at = coalesce(w.started_at, v_now),
      attempts = w.attempts + 1, updated_at = v_now
  FROM claimable
  WHERE w.id = claimable.id
  RETURNING w.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT, TEXT) TO service_role;

COMMIT;

-- Separate V1 worker scheduler. JOB14 is untouched. The API flag is OFF by
-- default; scheduled requests are inert until the structural rollout is enabled.
CREATE OR REPLACE FUNCTION app_private.run_opspilot_checkpoint_v1_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, app_private, net
AS $$
DECLARE
  cycle_url text;
  worker_url text;
  cron_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.checkpoint_work_units
    WHERE execution_mode = 'PRODUCTION'
      AND cursor #>> '{metadata,pipelineVersion}' = 'V1'
      AND status IN ('PENDING', 'LEASED')
      AND checkpoint_at <= clock_timestamp() - interval '1 minute'
  ) THEN RETURN; END IF;

  SELECT decrypted_secret INTO cycle_url FROM vault.decrypted_secrets
    WHERE name = 'opspilot_followup_cycle_url' LIMIT 1;
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets
    WHERE name = 'opspilot_cron_secret' LIMIT 1;
  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN
    RAISE WARNING 'V1 worker Vault credentials unavailable';
    RETURN;
  END IF;
  worker_url := replace(cycle_url, '/api/cron/followup-cycle', '/api/internal/checkpoint-v1/worker');
  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'opspilot-checkpoint-v1-worker') THEN
    PERFORM cron.schedule('opspilot-checkpoint-v1-worker', '* * * * *',
      'select app_private.run_opspilot_checkpoint_v1_worker();');
  END IF;
END $$;
