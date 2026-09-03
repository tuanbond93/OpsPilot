create table if not exists ghn_lastmile_operational_snapshots (
  id uuid primary key default gen_random_uuid(),
  hub_id text not null,
  source text not null,
  source_fetched_at timestamptz not null,
  staffing jsonb not null,
  workload jsonb not null,
  created_at timestamptz not null default now(),
  check (char_length(hub_id) between 5 and 20)
);

create index if not exists ghn_lastmile_operational_snapshots_hub_fetched_idx
  on ghn_lastmile_operational_snapshots (hub_id, source_fetched_at desc);

alter table ghn_lastmile_operational_snapshots enable row level security;
