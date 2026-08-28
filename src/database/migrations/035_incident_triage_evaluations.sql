-- L-10.2B: immutable, per-sync evidence for the deterministic pre-AI triage decision.
CREATE TABLE IF NOT EXISTS incident_triage_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  sync_run_id UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  route TEXT NOT NULL CHECK (route IN ('DATA_QUALITY_HOLD','AUTO_MONITOR','AUTO_HANDLE','AI_DECISION_REQUIRED','HUMAN_INVESTIGATION_REQUIRED')),
  reason_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  decision_complexity TEXT NOT NULL CHECK (decision_complexity IN ('DETERMINISTIC','UNCERTAIN','INSUFFICIENT_CONTEXT')),
  triage_reason TEXT NOT NULL,
  routing_version TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_incident_triage_evaluation_per_sync UNIQUE (incident_id, sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_triage_evaluations_route_created
  ON incident_triage_evaluations (route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_triage_evaluations_incident_created
  ON incident_triage_evaluations (incident_id, created_at DESC);

COMMENT ON TABLE incident_triage_evaluations IS
  'L-10.2B deterministic pre-AI route audit. It never represents financial impact or autonomous execution.';
