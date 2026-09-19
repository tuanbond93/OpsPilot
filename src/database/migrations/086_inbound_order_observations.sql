-- Migration 086: complete, PII-minimized normalized inbound observation population.
-- This table is deliberately separate from order_snapshots, which remains an
-- incident-selected evidence store used by existing incident workflows.

CREATE TABLE IF NOT EXISTS public.inbound_order_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  order_code TEXT NOT NULL,
  current_warehouse_id TEXT NULL,
  deliver_warehouse_id TEXT NULL,
  source_status TEXT NOT NULL,
  end_pick_at TIMESTAMPTZ NULL,
  weight_kg NUMERIC NULL,
  is_b2b BOOLEAN NULL,
  source_observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inbound_order_observations_run_order UNIQUE (sync_run_id, order_code)
);

CREATE INDEX IF NOT EXISTS idx_inbound_order_observations_run_destination
  ON public.inbound_order_observations (sync_run_id, deliver_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inbound_order_observations_run_current
  ON public.inbound_order_observations (sync_run_id, current_warehouse_id);

ALTER TABLE public.inbound_order_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inbound_order_observations FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.inbound_order_observations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inbound_order_observations_id_seq TO service_role;
