-- LC-12: unattended 2-hour follow-up cycle for the Miền Bắc 3 pilot.
--
-- The function only calls the protected OpsPilot endpoint. OpsPilot itself
-- performs: fresh source sync -> deterministic follow-up assessment ->
-- eligible Telegram dispatch. A reply is retained as audit evidence; it is
-- never treated as proof that the incident has resolved.
--
-- Before scheduling, add these two values in Supabase Vault (not in this file):
--   opspilot_followup_cycle_url  = https://opspilot-tau-lyart.vercel.app/api/cron/followup-cycle
--   opspilot_cron_secret         = the same CRON_SECRET configured in Vercel

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists app_private;

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
    body := '{}'::jsonb
  );
end;
$$;

create or replace function app_private.schedule_opspilot_followup_cycle()
returns void
language plpgsql
security definer
set search_path = public, extensions, app_private
as $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'opspilot-followup-cycle-mb3'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  -- UTC: 01,03,05,07,09,11 = 08:00,10:00,12:00,14:00,16:00,18:00 Vietnam.
  perform cron.schedule(
    'opspilot-followup-cycle-mb3',
    '0 1-11/2 * * *',
    'select app_private.run_opspilot_followup_cycle();'
  );
end;
$$;

do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'opspilot_followup_cycle_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'opspilot_cron_secret') then
    perform app_private.schedule_opspilot_followup_cycle();
  else
    raise notice 'Follow-up scheduler function installed. Add the two Vault secrets, then run: select app_private.schedule_opspilot_followup_cycle();';
  end if;
end;
$$;
