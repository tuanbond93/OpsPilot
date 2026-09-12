-- One governed recovery attempt for a natural checkpoint that fails before
-- operational processing starts. This extends the existing Supabase pg_cron
-- platform; it does not alter the 08/10/12/14/16/18 checkpoint schedule.

ALTER TABLE public.sync_runs
  ADD COLUMN IF NOT EXISTS checkpoint_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_checkpoint_at
  ON public.sync_runs(checkpoint_at)
  WHERE checkpoint_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.checkpoint_recoveries (
  checkpoint_at TIMESTAMPTZ PRIMARY KEY,
  recovery_attempt SMALLINT NOT NULL DEFAULT 1 CHECK (recovery_attempt = 1),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  recovery_token UUID NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  sync_run_id UUID NULL REFERENCES public.sync_runs(id) ON DELETE RESTRICT,
  failure_stage TEXT NULL,
  last_safe_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recovery state includes operational error metadata and is managed only by
-- the service role / security-definer dispatcher, never by browser clients.
ALTER TABLE public.checkpoint_recoveries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_checkpoint_recoveries_pending
  ON public.checkpoint_recoveries(scheduled_for)
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION app_private.dispatch_due_opspilot_checkpoint_recoveries()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, app_private
AS $$
DECLARE
  cycle_url text;
  cron_secret text;
  recovery record;
  dispatch_token uuid;
BEGIN
  SELECT decrypted_secret INTO cycle_url FROM vault.decrypted_secrets
    WHERE name = 'opspilot_followup_cycle_url' LIMIT 1;
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets
    WHERE name = 'opspilot_cron_secret' LIMIT 1;
  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN
    RAISE EXCEPTION 'Supabase Vault is missing OpsPilot recovery dispatch secrets';
  END IF;

  FOR recovery IN
    SELECT checkpoint_at FROM public.checkpoint_recoveries
    WHERE status = 'PENDING' AND scheduled_for <= now()
    ORDER BY scheduled_for
    FOR UPDATE SKIP LOCKED
  LOOP
    dispatch_token := gen_random_uuid();
    UPDATE public.checkpoint_recoveries
    SET status = 'DISPATCHED', recovery_token = dispatch_token
    WHERE checkpoint_at = recovery.checkpoint_at AND status = 'PENDING';

    PERFORM net.http_post(
      url := cycle_url || '?checkpoint_at=' || to_char(recovery.checkpoint_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '&recovery_attempt=1',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || cron_secret,
        'x-opspilot-recovery-token', dispatch_token::text
      ),
      body := '{}'::jsonb
    );
  END LOOP;
END;
$$;

DO $$
DECLARE existing_job_id bigint;
BEGIN
  FOR existing_job_id IN SELECT jobid FROM cron.job WHERE jobname = 'opspilot-followup-recovery-dispatch' LOOP
    PERFORM cron.unschedule(existing_job_id);
  END LOOP;
  PERFORM cron.schedule(
    'opspilot-followup-recovery-dispatch',
    '* * * * *',
    'select app_private.dispatch_due_opspilot_checkpoint_recoveries();'
  );
END;
$$;
