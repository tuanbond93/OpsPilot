-- Recovery delivery is unconfirmed until an effective checkpoint is durable.
-- Pre-071 historical DISPATCHED rows are deliberately not mutated here.

ALTER TABLE public.checkpoint_recoveries
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_request_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS last_http_status INTEGER NULL;

ALTER TABLE public.checkpoint_recoveries
  DROP CONSTRAINT IF EXISTS checkpoint_recoveries_recovery_attempt_check,
  DROP CONSTRAINT IF EXISTS checkpoint_recoveries_status_check;

ALTER TABLE public.checkpoint_recoveries
  ALTER COLUMN recovery_attempt SET DEFAULT 0,
  ADD CONSTRAINT checkpoint_recoveries_recovery_attempt_check CHECK (recovery_attempt BETWEEN 0 AND 3),
  ADD CONSTRAINT checkpoint_recoveries_status_check CHECK (status IN (
    'PENDING', 'DISPATCHING', 'RUNNING', 'CONFIRMED', 'FAILED_REQUIRES_ATTENTION',
    -- Retained only so an owner can reconcile historical rows after deployment.
    'DISPATCHED', 'SUCCEEDED', 'FAILED'
  ));

CREATE INDEX IF NOT EXISTS idx_checkpoint_recoveries_due
  ON public.checkpoint_recoveries(next_attempt_at)
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION app_private.dispatch_due_opspilot_checkpoint_recoveries()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, app_private, net
AS $$
DECLARE
  cycle_url text;
  cron_secret text;
  recovery record;
  response record;
  existing_sync uuid;
  dispatch_token uuid;
  request_id bigint;
  retry_at timestamptz;
BEGIN
  SELECT decrypted_secret INTO cycle_url FROM vault.decrypted_secrets
    WHERE name = 'opspilot_followup_cycle_url' LIMIT 1;
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets
    WHERE name = 'opspilot_cron_secret' LIMIT 1;
  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN
    RAISE EXCEPTION 'Supabase Vault is missing OpsPilot recovery dispatch secrets';
  END IF;

  -- A durable completed checkpoint is stronger evidence than a pg_net timeout.
  FOR recovery IN
    SELECT * FROM public.checkpoint_recoveries
    WHERE status = 'DISPATCHING'
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT id INTO existing_sync FROM public.sync_runs
      WHERE checkpoint_at = recovery.checkpoint_at
        AND (status = 'success' OR current_phase = 'COMPLETED')
      LIMIT 1;
    IF existing_sync IS NOT NULL THEN
      UPDATE public.checkpoint_recoveries
        SET status = 'CONFIRMED', completed_at = now(), sync_run_id = existing_sync
        WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
      CONTINUE;
    END IF;
    -- Do not turn an ambiguous client timeout into another execution while the
    -- original checkpoint is still running; checkpoint identity remains the
    -- final duplicate guard.
    IF EXISTS (SELECT 1 FROM public.sync_runs WHERE checkpoint_at = recovery.checkpoint_at) THEN
      CONTINUE;
    END IF;

    SELECT status_code, timed_out, error_msg INTO response
      FROM net._http_response WHERE id = recovery.last_request_id;
    IF FOUND AND (response.timed_out OR response.status_code >= 500 OR (response.status_code IS NULL AND response.error_msg IS NOT NULL)) THEN
      IF recovery.recovery_attempt >= 3 THEN
        UPDATE public.checkpoint_recoveries
          SET status = 'FAILED_REQUIRES_ATTENTION', completed_at = now(),
              failure_stage = 'CHECKPOINT_FAILED_REQUIRES_ATTENTION',
              last_http_status = response.status_code, last_safe_error = left(coalesce(response.error_msg, 'Recovery HTTP failure'), 500)
          WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
      ELSE
        retry_at := now() + make_interval(mins => 5 * greatest(1, recovery.recovery_attempt));
        UPDATE public.checkpoint_recoveries
          SET status = 'PENDING', next_attempt_at = retry_at, recovery_token = NULL,
              last_http_status = response.status_code, last_safe_error = left(coalesce(response.error_msg, 'Recovery HTTP failure'), 500)
          WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
      END IF;
    ELSIF FOUND THEN
      -- A non-retryable response without a completed checkpoint is terminal.
      UPDATE public.checkpoint_recoveries
        SET status = 'FAILED_REQUIRES_ATTENTION', completed_at = now(),
            failure_stage = 'CHECKPOINT_FAILED_REQUIRES_ATTENTION', last_http_status = response.status_code,
            last_safe_error = left(coalesce(response.error_msg, 'Recovery response lacked effective checkpoint evidence'), 500)
        WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
    ELSIF recovery.dispatch_started_at <= now() - interval '330 seconds' THEN
      IF recovery.recovery_attempt >= 3 THEN
        UPDATE public.checkpoint_recoveries
          SET status = 'FAILED_REQUIRES_ATTENTION', completed_at = now(), failure_stage = 'CHECKPOINT_FAILED_REQUIRES_ATTENTION',
              last_safe_error = 'Recovery HTTP response was not retained before timeout reconciliation'
          WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
      ELSE
        retry_at := now() + make_interval(mins => 5 * greatest(1, recovery.recovery_attempt));
        UPDATE public.checkpoint_recoveries
          SET status = 'PENDING', next_attempt_at = retry_at, recovery_token = NULL,
              last_safe_error = 'Recovery HTTP response was not retained before timeout reconciliation'
          WHERE checkpoint_at = recovery.checkpoint_at AND status = 'DISPATCHING';
      END IF;
    END IF;
  END LOOP;

  FOR recovery IN
    SELECT * FROM public.checkpoint_recoveries
    WHERE status = 'PENDING' AND coalesce(next_attempt_at, scheduled_for) <= now()
    ORDER BY coalesce(next_attempt_at, scheduled_for)
    FOR UPDATE SKIP LOCKED
  LOOP
    dispatch_token := gen_random_uuid();
    request_id := net.http_post(
      url := cycle_url || '?checkpoint_at=' || to_char(recovery.checkpoint_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '&recovery_attempt=1',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cron_secret, 'x-opspilot-recovery-token', dispatch_token::text),
      body := '{}'::jsonb,
      timeout_milliseconds := 330000
    );
    UPDATE public.checkpoint_recoveries
      SET status = 'DISPATCHING', recovery_attempt = recovery.recovery_attempt + 1,
          recovery_token = dispatch_token, dispatch_started_at = now(), last_request_id = request_id,
          last_http_status = NULL, last_safe_error = NULL
      WHERE checkpoint_at = recovery.checkpoint_at AND status = 'PENDING';
  END LOOP;
END;
$$;
