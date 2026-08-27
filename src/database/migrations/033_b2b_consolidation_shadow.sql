-- LC-11: proposal/audit records only. These records never hold orders, dispatch a vehicle,
-- send Telegram messages, or claim a financial saving.
CREATE TABLE IF NOT EXISTS b2b_consolidation_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  mode TEXT NOT NULL CHECK (mode = 'SHADOW'),
  verdict TEXT NOT NULL CHECK (verdict IN ('ELIGIBLE_SHADOW', 'DISPATCH_NOW', 'HUMAN_INVESTIGATION_REQUIRED')),
  trip JSONB NOT NULL,
  orders JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS b2b_consolidation_shadow_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES b2b_consolidation_shadow_runs(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type = 'CREATED'),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_b2b_consolidation_shadow_runs_created ON b2b_consolidation_shadow_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_consolidation_shadow_audits_run ON b2b_consolidation_shadow_audits(run_id, occurred_at ASC);

CREATE OR REPLACE FUNCTION reject_b2b_consolidation_shadow_run_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'b2b_consolidation_shadow_runs records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS b2b_consolidation_shadow_runs_immutable ON b2b_consolidation_shadow_runs;
CREATE TRIGGER b2b_consolidation_shadow_runs_immutable BEFORE UPDATE OR DELETE ON b2b_consolidation_shadow_runs
FOR EACH ROW EXECUTE FUNCTION reject_b2b_consolidation_shadow_run_mutation();

CREATE OR REPLACE FUNCTION reject_b2b_consolidation_shadow_audit_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'b2b_consolidation_shadow_audits records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS b2b_consolidation_shadow_audits_immutable ON b2b_consolidation_shadow_audits;
CREATE TRIGGER b2b_consolidation_shadow_audits_immutable BEFORE UPDATE OR DELETE ON b2b_consolidation_shadow_audits
FOR EACH ROW EXECUTE FUNCTION reject_b2b_consolidation_shadow_audit_mutation();
