-- Correct the Phase 2 dispatcher method without changing its queue, lease, or retry contract.
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
  UPDATE public.phase2_checkpoint_work
    SET status = CASE WHEN attempt_count >= 3 THEN 'FAILED' ELSE 'PENDING' END,
        next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at ELSE now() + make_interval(mins => 5 * greatest(1, attempt_count)) END,
        dispatch_token = NULL, last_safe_error = 'Phase2 dispatch lease expired before endpoint confirmation'
    WHERE status IN ('DISPATCHING', 'RUNNING') AND started_at <= now() - interval '330 seconds';
  FOR work IN SELECT * FROM public.phase2_checkpoint_work WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LOOP
    token := gen_random_uuid();
    UPDATE public.phase2_checkpoint_work SET status='DISPATCHING', attempt_count=attempt_count+1, dispatch_token=token, started_at=now(), last_safe_error=NULL
      WHERE checkpoint_at=work.checkpoint_at AND status='PENDING';
    PERFORM net.http_get(
      url := phase2_url || '?checkpoint_at=' || to_char(work.checkpoint_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || cron_secret,'x-opspilot-phase2-token',token::text),
      timeout_milliseconds := 300000);
  END LOOP;
END;
$$;
