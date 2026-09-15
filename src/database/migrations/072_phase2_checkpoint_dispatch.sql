-- Phase 2 is durable work, deliberately outside the primary checkpoint HTTP budget.
CREATE TABLE IF NOT EXISTS public.phase2_checkpoint_work (
  checkpoint_at TIMESTAMPTZ PRIMARY KEY,
  sync_run_id UUID NOT NULL UNIQUE REFERENCES public.sync_runs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHING', 'RUNNING', 'COMPLETED', 'FAILED')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_token UUID NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  last_safe_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.phase2_checkpoint_work ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_phase2_checkpoint_work_due ON public.phase2_checkpoint_work(next_attempt_at) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION app_private.dispatch_due_opspilot_phase2_checkpoint_work()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, vault, app_private, net
AS $$
DECLARE cycle_url text; phase2_url text; cron_secret text; work record; token uuid;
BEGIN
  SELECT decrypted_secret INTO cycle_url FROM vault.decrypted_secrets WHERE name = 'opspilot_followup_cycle_url' LIMIT 1;
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name = 'opspilot_cron_secret' LIMIT 1;
  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN RAISE EXCEPTION 'Supabase Vault is missing OpsPilot Phase2 dispatch secrets'; END IF;
  phase2_url := replace(cycle_url, '/api/cron/followup-cycle', '/api/cron/phase2-checkpoint');
  -- A crashed or unreachable dispatcher is retried by the existing minute cron, at most three times.
  UPDATE public.phase2_checkpoint_work
    SET status = CASE WHEN attempt_count >= 3 THEN 'FAILED' ELSE 'PENDING' END,
        next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at ELSE now() + make_interval(mins => 5 * greatest(1, attempt_count)) END,
        dispatch_token = NULL, last_safe_error = 'Phase2 dispatch lease expired before endpoint confirmation'
    WHERE status IN ('DISPATCHING', 'RUNNING') AND started_at <= now() - interval '330 seconds';
  FOR work IN SELECT * FROM public.phase2_checkpoint_work WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LOOP
    token := gen_random_uuid();
    UPDATE public.phase2_checkpoint_work SET status='DISPATCHING', attempt_count=attempt_count+1, dispatch_token=token, started_at=now(), last_safe_error=NULL
      WHERE checkpoint_at=work.checkpoint_at AND status='PENDING';
    PERFORM net.http_post(
      url := phase2_url || '?checkpoint_at=' || to_char(work.checkpoint_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || cron_secret,'x-opspilot-phase2-token',token::text),
      body := '{}'::jsonb, timeout_milliseconds := 300000);
  END LOOP;
END;
$$;

DO $$ DECLARE existing_job_id bigint; BEGIN
  FOR existing_job_id IN SELECT jobid FROM cron.job WHERE jobname = 'opspilot-phase2-checkpoint-dispatch' LOOP PERFORM cron.unschedule(existing_job_id); END LOOP;
  PERFORM cron.schedule('opspilot-phase2-checkpoint-dispatch', '* * * * *', 'select app_private.dispatch_due_opspilot_phase2_checkpoint_work();');
END $$;
