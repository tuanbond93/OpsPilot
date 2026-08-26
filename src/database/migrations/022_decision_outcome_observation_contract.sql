-- OpsPilot Migration 022: immutable outcome-observation contract for a Decision.
-- It defines evidence provenance and a measurement window only. It never assigns
-- SUCCESS/FAILURE/INCONCLUSIVE and never calculates financial impact.

CREATE TABLE IF NOT EXISTS decision_outcome_observation_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE RESTRICT,
  followup_schedule_id UUID NOT NULL UNIQUE REFERENCES decision_followup_schedules(id) ON DELETE RESTRICT,
  baseline_evidence_snapshot_id UUID NULL REFERENCES decision_evidence_snapshots(id) ON DELETE RESTRICT,
  baseline_captured_at TIMESTAMPTZ NOT NULL,
  baseline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  measurement_window_start TIMESTAMPTZ NOT NULL,
  measurement_window_end TIMESTAMPTZ NOT NULL,
  required_evidence_types JSONB NOT NULL DEFAULT '["EXECUTION_REFERENCE","POST_EXECUTION_OPERATIONAL_SNAPSHOT"]'::jsonb
    CHECK (jsonb_typeof(required_evidence_types) = 'array'),
  contract_version TEXT NOT NULL CHECK (contract_version = 'LC05_V1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (measurement_window_end >= measurement_window_start)
);

CREATE INDEX IF NOT EXISTS idx_decision_outcome_contract_window
  ON decision_outcome_observation_contracts(measurement_window_end);

CREATE OR REPLACE FUNCTION create_outcome_observation_contract_after_schedule() RETURNS TRIGGER AS $$
DECLARE
  d decisions%ROWTYPE;
  baseline decision_evidence_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO d FROM decisions WHERE id = NEW.decision_id;
  SELECT * INTO baseline FROM decision_evidence_snapshots WHERE decision_id = NEW.decision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DECISION_EVIDENCE_SNAPSHOT_REQUIRED'; END IF;

  INSERT INTO decision_outcome_observation_contracts(
    decision_id, followup_schedule_id, baseline_evidence_snapshot_id, baseline_captured_at,
    baseline_snapshot, measurement_window_start, measurement_window_end, contract_version
  ) VALUES (
    NEW.decision_id, NEW.id, baseline.id, baseline.captured_at, baseline.snapshot,
    COALESCE(d.executed_at, NEW.created_at), NEW.check_at, 'LC05_V1'
  ) ON CONFLICT (decision_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS decision_followup_observation_contract ON decision_followup_schedules;
CREATE TRIGGER decision_followup_observation_contract
AFTER INSERT ON decision_followup_schedules
FOR EACH ROW EXECUTE FUNCTION create_outcome_observation_contract_after_schedule();

CREATE OR REPLACE FUNCTION reject_decision_outcome_contract_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decision_outcome_observation_contracts records are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_outcome_contract_immutable ON decision_outcome_observation_contracts;
CREATE TRIGGER decision_outcome_contract_immutable
BEFORE UPDATE OR DELETE ON decision_outcome_observation_contracts
FOR EACH ROW EXECUTE FUNCTION reject_decision_outcome_contract_mutation();
