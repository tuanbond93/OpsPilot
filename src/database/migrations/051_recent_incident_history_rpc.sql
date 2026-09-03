-- Return a bounded number of recent snapshots per incident. A plain PostgREST
-- query is capped globally (normally 1,000 rows), which can silently starve
-- incidents later in the result set as history accumulates.
create or replace function public.get_recent_incident_histories(
  p_incident_ids uuid[],
  p_limit_per_incident integer default 5
)
returns setof public.incident_history
language sql
stable
security invoker
set search_path = public
as $$
  select ranked.row_data
  from (
    select h as row_data,
           row_number() over (partition by h.incident_id order by h.recorded_at desc) as row_num
    from public.incident_history h
    where h.incident_id = any(p_incident_ids)
  ) ranked
  where ranked.row_num <= greatest(2, least(coalesce(p_limit_per_incident, 5), 20));
$$;

revoke all on function public.get_recent_incident_histories(uuid[], integer) from public, anon, authenticated;
grant execute on function public.get_recent_incident_histories(uuid[], integer) to service_role;
