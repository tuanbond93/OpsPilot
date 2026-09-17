-- Migration 076: Near-Term Capacity Shadow Observation & Historical Replay Store
-- Isolated append-only observational storage for Policy B shadow decisions.
-- Never creates executable decisions, never dispatches Telegram notifications, never mutates governed case state.

CREATE TABLE IF NOT EXISTS public.near_term_capacity_shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shadow_id TEXT NOT NULL UNIQUE,
  source_candidate_id TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('LIVE_SHADOW', 'HISTORICAL_REPLAY')),
  warehouse_id TEXT NOT NULL,
  warehouse_name TEXT NOT NULL,
  risk_type TEXT NOT NULL DEFAULT 'KHO_TON',
  observed_at TIMESTAMPTZ NOT NULL,
  current_orders INTEGER NULL,
  current_kg NUMERIC NULL,
  current_orders_status TEXT NOT NULL,
  current_kg_status TEXT NOT NULL,
  operational_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_provider TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  ai_decision_type TEXT NOT NULL DEFAULT 'NEAR_TERM_CAPACITY_SHADOW',
  ai_recommended_action TEXT NOT NULL,
  ai_confidence NUMERIC NULL,
  ai_reason_summary TEXT NOT NULL,
  critic_verdict TEXT NOT NULL,
  critic_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  shadow_status TEXT NOT NULL,
  decision_generated_at TIMESTAMPTZ NOT NULL,
  critic_completed_at TIMESTAMPTZ NOT NULL,
  outcome_backtest JSONB NULL,
  provisional_label TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_near_term_shadow_candidate_mode UNIQUE (source_candidate_id, source_mode)
);

ALTER TABLE public.near_term_capacity_shadow_decisions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_near_term_shadow_mode_observed
  ON public.near_term_capacity_shadow_decisions (source_mode, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_near_term_shadow_candidate
  ON public.near_term_capacity_shadow_decisions (source_candidate_id);

CREATE INDEX IF NOT EXISTS idx_near_term_shadow_warehouse
  ON public.near_term_capacity_shadow_decisions (warehouse_id);

CREATE OR REPLACE FUNCTION reject_near_term_capacity_shadow_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'near_term_capacity_shadow_decisions records are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_near_term_capacity_shadow_immutable ON public.near_term_capacity_shadow_decisions;
CREATE TRIGGER trg_near_term_capacity_shadow_immutable
  BEFORE UPDATE OR DELETE ON public.near_term_capacity_shadow_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_near_term_capacity_shadow_mutation();
