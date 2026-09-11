-- Isolated append-only prospective shadow evidence. Do not run this migration
-- without separate deployment approval. No existing operational table changes.
CREATE TABLE IF NOT EXISTS adaptive_observation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  observed_at TIMESTAMPTZ NOT NULL,
  trigger TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adaptive_observation_case_observed ON adaptive_observation_snapshots(case_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_adaptive_observation_observed ON adaptive_observation_snapshots(observed_at DESC);

CREATE TABLE IF NOT EXISTS checkpoint_case_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL,
  checkpoint_at TIMESTAMPTZ NOT NULL,
  case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  engine_member BOOLEAN NULL, telegram_status_member BOOLEAN NULL, dashboard_member BOOLEAN NULL,
  region TEXT NULL, province TEXT NULL, warehouse TEXT NULL, incident_state TEXT NULL, affected_order_count INTEGER NULL,
  schema_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_case_checkpoint ON checkpoint_case_snapshots(checkpoint_id, checkpoint_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoint_case_case ON checkpoint_case_snapshots(case_id, checkpoint_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  snapshot_id UUID NOT NULL REFERENCES adaptive_observation_snapshots(id) ON DELETE RESTRICT,
  case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  observed_at TIMESTAMPTZ NOT NULL, engine_version TEXT NOT NULL, policy_version TEXT NOT NULL,
  v1_decision TEXT NOT NULL, v2_decision TEXT NOT NULL, risk TEXT NOT NULL, confidence TEXT NOT NULL,
  reason_code TEXT NOT NULL, human_reason TEXT NOT NULL, target TEXT NOT NULL, next_check_at TIMESTAMPTZ NULL,
  evidence_completeness TEXT NOT NULL, comparison_class TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adaptive_shadow_decision_snapshot ON adaptive_shadow_decisions(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_adaptive_shadow_decision_case_observed ON adaptive_shadow_decisions(case_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS shadow_outcome_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  shadow_decision_id UUID NOT NULL REFERENCES adaptive_shadow_decisions(id) ON DELETE RESTRICT,
  observed_at TIMESTAMPTZ NOT NULL, outcome_type TEXT NOT NULL, evidence JSONB NOT NULL, confidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shadow_outcome_decision_observed ON shadow_outcome_observations(shadow_decision_id, observed_at DESC);

CREATE OR REPLACE FUNCTION reject_adaptive_shadow_history_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ADAPTIVE_SHADOW_HISTORY_IMMUTABLE'; END; $$;
CREATE TRIGGER adaptive_observation_snapshots_immutable BEFORE UPDATE OR DELETE ON adaptive_observation_snapshots FOR EACH ROW EXECUTE FUNCTION reject_adaptive_shadow_history_mutation();
CREATE TRIGGER checkpoint_case_snapshots_immutable BEFORE UPDATE OR DELETE ON checkpoint_case_snapshots FOR EACH ROW EXECUTE FUNCTION reject_adaptive_shadow_history_mutation();
CREATE TRIGGER adaptive_shadow_decisions_immutable BEFORE UPDATE OR DELETE ON adaptive_shadow_decisions FOR EACH ROW EXECUTE FUNCTION reject_adaptive_shadow_history_mutation();
CREATE TRIGGER shadow_outcome_observations_immutable BEFORE UPDATE OR DELETE ON shadow_outcome_observations FOR EACH ROW EXECUTE FUNCTION reject_adaptive_shadow_history_mutation();

-- Defense in depth: browser roles have no direct access. The service role
-- bypasses RLS but is limited to INSERT/SELECT privileges for this release;
-- the only intended write path is a validated server-side writer.
ALTER TABLE adaptive_observation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_case_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_shadow_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_outcome_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_observation_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_case_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE adaptive_shadow_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE shadow_outcome_observations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE adaptive_observation_snapshots, checkpoint_case_snapshots, adaptive_shadow_decisions, shadow_outcome_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE adaptive_observation_snapshots, checkpoint_case_snapshots, adaptive_shadow_decisions, shadow_outcome_observations TO service_role;

COMMENT ON TABLE adaptive_observation_snapshots IS 'Append-only adaptive shadow evidence. Browser roles have no direct access.';
COMMENT ON TABLE checkpoint_case_snapshots IS 'Append-only checkpoint membership evidence. Browser roles have no direct access.';
COMMENT ON TABLE adaptive_shadow_decisions IS 'Append-only V2 shadow decisions; requires persisted snapshot reference.';
COMMENT ON TABLE shadow_outcome_observations IS 'Append-only later observed outcomes; never implies causal attribution.';
