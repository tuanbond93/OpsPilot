-- V2 shadow work is independent of V1 but is eligible five minutes after
-- CHECKPOINT_READY. This does not alter JOB14 or V2's SHADOW egress guard.
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
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.checkpoint_work_units
    WHERE execution_mode = 'SHADOW'
      AND status IN ('PENDING', 'LEASED')
      AND created_at <= clock_timestamp() - interval '5 minutes'
  ) THEN RETURN; END IF;

  SELECT decrypted_secret INTO cycle_url FROM vault.decrypted_secrets
    WHERE name = 'opspilot_followup_cycle_url' LIMIT 1;
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets
    WHERE name = 'opspilot_cron_secret' LIMIT 1;
  IF coalesce(cycle_url, '') = '' OR coalesce(cron_secret, '') = '' THEN
    RAISE WARNING 'V2 worker Vault credentials unavailable';
    RETURN;
  END IF;
  worker_url := replace(cycle_url, '/api/cron/followup-cycle', '/api/internal/checkpoint-v2/worker');
  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;
