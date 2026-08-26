-- OpsPilot Migration 021: deterministic Decision follow-up scheduling.
-- This records when evidence should be re-checked. It does not execute work,
-- verify outcomes, or calculate financial impact.

CREATE TABLE IF NOT EXISTS decision_followup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE RESTRICT,
  execution_audit_event_id UUID NOT NULL UNIQUE REFERENCES decision_audit_events(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status = 'SCHEDULED'),
  check_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL CHECK (policy_version = 'LC04_V1'),
  risk_level_at_schedule TEXT NOT NULL CHECK (risk_level_at_schedule IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  scheduled_by TEXT NOT NULL CHECK (NULLIF(BTRIM(scheduled_by), '') IS NOT NULL),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_followup_schedules_due
  ON decision_followup_schedules(status, check_at);

CREATE OR REPLACE FUNCTION schedule_followup_after_decision_execution() RETURNS TRIGGER AS $$
DECLARE
  d decisions%ROWTYPE;
  delay_minutes INTEGER;
BEGIN
  IF NEW.new_status <> 'EXECUTED' THEN RETURN NEW; END IF;
  SELECT * INTO d FROM decisions WHERE id = NEW.decision_id;
  IF d.decision_mode <> 'HUMAN_APPROVAL' THEN RETURN NEW; END IF;

  delay_minutes := CASE d.risk_level
    WHEN 'CRITICAL' THEN 60
    WHEN 'HIGH' THEN 120
    WHEN 'MEDIUM' THEN 240
    ELSE 480
  END;

  INSERT INTO decision_followup_schedules(
    decision_id, execution_audit_event_id, check_at, policy_version,
    risk_level_at_schedule, scheduled_by, idempotency_key
  ) VALUES (
    d.id, NEW.id, COALESCE(d.executed_at, NEW.occurred_at) + make_interval(mins => delay_minutes),
    'LC04_V1', d.risk_level, NEW.actor, NEW.idempotency_key || ':followup'
  ) ON CONFLICT (decision_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS decision_execution_followup_schedule ON decision_audit_events;
CREATE TRIGGER decision_execution_followup_schedule
AFTER INSERT ON decision_audit_events
FOR EACH ROW WHEN (NEW.new_status = 'EXECUTED')
EXECUTE FUNCTION schedule_followup_after_decision_execution();

CREATE OR REPLACE FUNCTION reject_decision_followup_schedule_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decision_followup_schedules records are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_followup_schedule_immutable ON decision_followup_schedules;
CREATE TRIGGER decision_followup_schedule_immutable
BEFORE UPDATE OR DELETE ON decision_followup_schedules
FOR EACH ROW EXECUTE FUNCTION reject_decision_followup_schedule_mutation();
