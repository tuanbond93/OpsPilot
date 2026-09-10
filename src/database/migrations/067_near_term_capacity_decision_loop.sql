-- Phase 2: immutable Lead ground truth and case snapshots.  Decisions and
-- work orders remain in the existing Phase 1 tables/contracts.
CREATE TABLE IF NOT EXISTS near_term_capacity_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id TEXT NOT NULL, warehouse_name TEXT NOT NULL,
  current_risk_snapshot JSONB NOT NULL, lead_fact_snapshot JSONB NULL,
  decision_context JSONB NULL, ai_recommendation JSONB NULL, critic_result JSONB NULL,
  status TEXT NOT NULL CHECK (status IN ('FACT_REQUESTED','FACT_CAPTURED','HUMAN_INVESTIGATION_REQUIRED','DECISION_READY','CLOSED')),
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE near_term_capacity_cases ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_near_term_capacity_case
  ON near_term_capacity_cases ((active)) WHERE active;
CREATE TABLE IF NOT EXISTS near_term_capacity_fact_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), case_id UUID NOT NULL REFERENCES near_term_capacity_cases(id) ON DELETE RESTRICT,
  interaction_id TEXT NOT NULL, supplied_by TEXT NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source = 'HUMAN_OPERATIONAL_GROUND_TRUTH'), payload JSONB NOT NULL,
  UNIQUE(case_id), UNIQUE(interaction_id)
);
ALTER TABLE near_term_capacity_fact_responses ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS near_term_capacity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), case_id UUID NOT NULL REFERENCES near_term_capacity_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, actor TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE near_term_capacity_events ENABLE ROW LEVEL SECURITY;
