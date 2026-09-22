-- Snapshot Storage V3 external shadow database.
-- Execute only in the SECONDARY Supabase project after application review.
-- This schema has no foreign keys to primary OpsPilot tables.

CREATE TABLE IF NOT EXISTS public.shadow_sync_runs (
  sync_run_id TEXT PRIMARY KEY,
  source_updated_at TIMESTAMPTZ NULL,
  evaluation_reference_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.order_state_versions (
  state_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  material_state JSONB NOT NULL CHECK (jsonb_typeof(material_state) = 'object'),
  valid_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_order_state_versions_order_hash UNIQUE (order_code, material_hash)
);

CREATE TABLE IF NOT EXISTS public.sync_run_order_refs (
  ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id TEXT NOT NULL,
  order_code TEXT NOT NULL,
  state_version_id UUID NOT NULL,
  warehouse_id TEXT NOT NULL DEFAULT '',
  source_status TEXT NOT NULL,
  reason_code TEXT NULL,
  evaluation_reference_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sync_run_order_ref_identity UNIQUE (sync_run_id, order_code, warehouse_id, source_status)
);

CREATE INDEX IF NOT EXISTS idx_order_state_versions_order_code
  ON public.order_state_versions(order_code);
CREATE INDEX IF NOT EXISTS idx_order_state_versions_hash
  ON public.order_state_versions(material_hash);
CREATE INDEX IF NOT EXISTS idx_sync_run_order_refs_sync_run
  ON public.sync_run_order_refs(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_sync_run_order_refs_state_version
  ON public.sync_run_order_refs(state_version_id);
CREATE INDEX IF NOT EXISTS idx_sync_run_order_refs_warehouse
  ON public.sync_run_order_refs(sync_run_id, warehouse_id, reason_code);

CREATE TABLE IF NOT EXISTS public.snapshot_v3_shadow_comparisons (
  comparison_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id TEXT NOT NULL UNIQUE,
  legacy_row_count INTEGER NOT NULL,
  v3_row_count INTEGER NOT NULL,
  cohort_count_match BOOLEAN NOT NULL,
  order_set_match BOOLEAN NOT NULL,
  identity_set_match BOOLEAN NOT NULL,
  material_state_match BOOLEAN NOT NULL,
  age_match BOOLEAN NOT NULL,
  journey_match BOOLEAN NOT NULL,
  reason_code_match BOOLEAN NOT NULL,
  source_freshness_match BOOLEAN NOT NULL,
  mismatch_count INTEGER NOT NULL,
  comparison_status TEXT NOT NULL CHECK (comparison_status IN ('MATCH', 'MISMATCH')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshot_v3_shadow_comparisons_status
  ON public.snapshot_v3_shadow_comparisons(comparison_status, created_at DESC);

ALTER TABLE public.shadow_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_state_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_run_order_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_v3_shadow_comparisons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shadow_sync_runs, public.order_state_versions,
  public.sync_run_order_refs, public.snapshot_v3_shadow_comparisons
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.shadow_sync_runs TO service_role;
GRANT SELECT, INSERT ON TABLE public.order_state_versions TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sync_run_order_refs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.snapshot_v3_shadow_comparisons TO service_role;

COMMENT ON TABLE public.shadow_sync_runs IS
  'Minimal external identifiers and timing metadata for V3 shadow cohorts; sync_run_id is owned by the primary system.';
COMMENT ON TABLE public.order_state_versions IS
  'V3 shadow-only immutable material state versions.';
COMMENT ON TABLE public.sync_run_order_refs IS
  'V3 shadow-only per-run references; no primary database foreign keys.';
COMMENT ON TABLE public.snapshot_v3_shadow_comparisons IS
  'V3 shadow-only durable comparator results.';

CREATE OR REPLACE FUNCTION public.snapshot_v3_storage_telemetry()
RETURNS TABLE (
  state_version_rows BIGINT,
  state_version_avg_bytes NUMERIC,
  reference_rows BIGINT,
  reference_avg_bytes NUMERIC,
  state_version_bytes_total BIGINT,
  reference_bytes_total BIGINT,
  legacy_equivalent_bytes BIGINT,
  actual_storage_reduction_pct NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH v3 AS (
    SELECT
      count(*)::BIGINT AS state_rows,
      avg(pg_column_size(v))::NUMERIC AS state_avg,
      sum(pg_column_size(v))::BIGINT AS state_bytes
    FROM public.order_state_versions v
  ), refs AS (
    SELECT
      count(*)::BIGINT AS ref_rows,
      avg(pg_column_size(r))::NUMERIC AS ref_avg,
      sum(pg_column_size(r))::BIGINT AS ref_bytes
    FROM public.sync_run_order_refs r
  )
  SELECT
    v3.state_rows,
    v3.state_avg,
    refs.ref_rows,
    refs.ref_avg,
    COALESCE(v3.state_bytes, 0),
    COALESCE(refs.ref_bytes, 0),
    NULL::BIGINT,
    NULL::NUMERIC
  FROM v3 CROSS JOIN refs;
$$;

REVOKE ALL ON FUNCTION public.snapshot_v3_storage_telemetry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_v3_storage_telemetry() TO service_role;
