-- Migration 098: Additive Checkpoint Pipeline V2 Independent Worker Scheduler
-- Reuses proven pg_cron + pg_net + Supabase Vault pattern from JOB14 and Phase 2.
-- Enforces execution_mode = 'SHADOW' check before triggering HTTP POST.
-- Cadence: Recurring every minute (* * * * *).
-- Strictly additive: Does NOT modify Migration 096 or 097, and does NOT alter JOB14 schedule.

CREATE OR REPLACE FUNCTION app_private.run_opspilot_checkpoint_v2_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, app_private, net
AS $$
DECLARE
  cycle_url text;
  worker_url text;
  cron_secret text;
  has_work boolean;
BEGIN
  -- 1. Check if there are any claimable or active SHADOW work units before dispatching HTTP
  SELECT EXISTS (
    SELECT 1 FROM public.checkpoint_work_units
    WHERE execution_mode = 'SHADOW'
      AND status IN ('PENDING', 'LEASED')
    LIMIT 1
  ) INTO has_work;

  IF NOT has_work THEN
    RETURN;
  END IF;

  -- 2. Retrieve credentials securely from Supabase Vault
  SELECT decrypted_secret INTO cycle_url
  FROM vault.decrypted_secrets
  WHERE name = 'opspilot_followup_cycle_url'
  LIMIT 1;

  SELECT decrypted_secret INTO cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'opspilot_cron_secret'
  LIMIT 1;

  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN
    RAISE WARNING 'Supabase Vault is missing opspilot_followup_cycle_url or opspilot_cron_secret; skipping V2 worker invocation.';
    RETURN;
  END IF;

  worker_url := replace(cycle_url, '/api/cron/followup-cycle', '/api/internal/checkpoint-v2/worker');

  -- 3. Non-blocking HTTP POST via pg_net with a 60s timeout
  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

-- Schedule the recurring worker trigger once per minute via pg_cron
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  FOR existing_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'opspilot-checkpoint-v2-worker'
  LOOP
    PERFORM cron.unschedule(existing_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'opspilot-checkpoint-v2-worker',
    '* * * * *',
    'select app_private.run_opspilot_checkpoint_v2_worker();'
  );
END $$;
