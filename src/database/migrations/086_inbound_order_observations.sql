-- Migration 086: complete, PII-minimized normalized inbound observation population.
-- This table is deliberately separate from order_snapshots, which remains an
-- incident-selected evidence store used by existing incident workflows.
-- Retention is OWNER_GOVERNED: retain until an Owner-approved purge. This
-- migration intentionally creates no TTL, cleanup job, or destructive purge.

CREATE TABLE IF NOT EXISTS public.inbound_order_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL DEFAULT 'RILLNET',
  order_code TEXT NOT NULL,
  current_warehouse_id TEXT NULL,
  deliver_warehouse_id TEXT NULL,
  source_status TEXT NOT NULL,
  end_pick_at TIMESTAMPTZ NULL,
  weight_kg NUMERIC NULL,
  is_b2b BOOLEAN NULL,
  source_observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inbound_order_observations_run_source_order UNIQUE (sync_run_id, source_system, order_code)
);

-- A manifest is the authority boundary for a batched snapshot. Observation
-- rows are never authoritative merely because some rows happen to exist.
CREATE TABLE IF NOT EXISTS public.inbound_population_manifests (
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL DEFAULT 'RILLNET',
  population_status TEXT NOT NULL CHECK (population_status IN ('STARTED', 'COMPLETE', 'FAILED')),
  normalized_population_count INTEGER NOT NULL,
  expected_observation_count INTEGER NOT NULL,
  persisted_observation_count INTEGER NOT NULL DEFAULT 0,
  duplicate_identical_count INTEGER NOT NULL DEFAULT 0,
  duplicate_conflict_count INTEGER NOT NULL DEFAULT 0,
  population_completed_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sync_run_id, source_system)
);

CREATE INDEX IF NOT EXISTS idx_inbound_order_observations_run_destination
  ON public.inbound_order_observations (sync_run_id, deliver_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inbound_order_observations_run_current
  ON public.inbound_order_observations (sync_run_id, current_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inbound_population_manifests_complete
  ON public.inbound_population_manifests (population_status, population_completed_at DESC);

COMMENT ON TABLE public.inbound_order_observations IS
  'RETENTION_POLICY=RETAIN_UNTIL_OWNER_APPROVED_PURGE; RETENTION_OWNER=OWNER_GOVERNED; AUTO_DELETE=NO';
COMMENT ON TABLE public.inbound_population_manifests IS
  'Completeness manifest for governed inbound evidence snapshots; retention is OWNER_GOVERNED.';

ALTER TABLE public.inbound_order_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_population_manifests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inbound_order_observations FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbound_population_manifests FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.inbound_order_observations TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.inbound_population_manifests TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inbound_order_observations_id_seq TO service_role;
