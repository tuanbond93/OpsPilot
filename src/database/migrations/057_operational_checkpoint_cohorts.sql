-- Apply before deploying the per-order checkpoint engine.
alter table public.followup_cases add column if not exists operational_cohort jsonb;

create or replace function app_private.schedule_opspilot_followup_cycle()
returns void language plpgsql security definer
set search_path = public, extensions, app_private
as $$
declare existing_job_id bigint;
begin
  for existing_job_id in select jobid from cron.job where jobname = 'opspilot-followup-cycle-mb3'
  loop perform cron.unschedule(existing_job_id); end loop;
  -- Asia/Ho_Chi_Minh 08,10,14,18,20; 08 is snapshot-only.
  perform cron.schedule('opspilot-followup-cycle-mb3', '0 1,3,7,11,13 * * *', 'select app_private.run_opspilot_followup_cycle();');
end;
$$;
do $$ begin
  if exists (select 1 from vault.decrypted_secrets where name = 'opspilot_followup_cycle_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'opspilot_cron_secret') then
    perform app_private.schedule_opspilot_followup_cycle();
  end if;
end; $$;
