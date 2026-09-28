-- Migration 102: Partitioned durable V1 follow-up input chunks.
-- Prevents giant unpartitioned writes to checkpoint_v1_followup_inputs while preserving exact V1 semantics.
BEGIN;

CREATE TABLE IF NOT EXISTS public.checkpoint_v1_followup_input_chunks (
  sync_run_id UUID NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  deterministic_work_key TEXT NOT NULL,
  orders JSONB NOT NULL,
  incidents JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sync_run_id, chunk_index),
  CONSTRAINT checkpoint_v1_followup_input_chunks_orders_array CHECK (jsonb_typeof(orders) = 'array'),
  CONSTRAINT checkpoint_v1_followup_input_chunks_incidents_array CHECK (jsonb_typeof(incidents) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_v1_input_chunks_work_key
  ON public.checkpoint_v1_followup_input_chunks (deterministic_work_key);

ALTER TABLE public.checkpoint_v1_followup_input_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkpoint_v1_followup_input_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.checkpoint_v1_followup_input_chunks TO service_role;

COMMIT;
