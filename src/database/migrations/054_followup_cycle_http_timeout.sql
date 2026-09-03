-- Keep applied migrations immutable. Migration 040 originally installed this
-- function with pg_net's default timeout; update only the function body here.
-- The cron schedule and Vault values remain unchanged.

create or replace function app_private.run_opspilot_followup_cycle()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  cycle_url text;
  cron_secret text;
begin
  select decrypted_secret into cycle_url
  from vault.decrypted_secrets
  where name = 'opspilot_followup_cycle_url'
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'opspilot_cron_secret'
  limit 1;

  if coalesce(cycle_url, '') = '' or coalesce(cron_secret, '') = '' then
    raise exception 'Supabase Vault is missing opspilot_followup_cycle_url or opspilot_cron_secret';
  end if;

  perform net.http_post(
    url := cycle_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;
