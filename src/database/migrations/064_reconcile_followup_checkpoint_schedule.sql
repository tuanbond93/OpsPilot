-- Reconcile the production follow-up cycle with the governed Vietnam-time
-- checkpoints: 08:00, 10:00, 12:00, 14:00, 16:00 and 18:00.
-- pg_cron evaluates this expression in UTC.
create or replace function app_private.schedule_opspilot_followup_cycle()
returns void language plpgsql security definer
set search_path = public, extensions, app_private
as $$
declare existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'opspilot-followup-cycle-mb3'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'opspilot-followup-cycle-mb3',
    '0 1,3,5,7,9,11 * * *',
    'select app_private.run_opspilot_followup_cycle();'
  );
end;
$$;

do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'opspilot_followup_cycle_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'opspilot_cron_secret') then
    perform app_private.schedule_opspilot_followup_cycle();
  end if;
end;
$$;
