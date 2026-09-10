-- Append-only observability for scheduled follow-up checkpoints.
CREATE TABLE IF NOT EXISTS checkpoint_dispatch_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id UUID NULL REFERENCES sync_runs(id) ON DELETE RESTRICT,
  checkpoint_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  execution_status TEXT NOT NULL CHECK (execution_status IN ('SUCCESS', 'FAILED')),
  http_status INTEGER NULL,
  supported_cases_evaluated INTEGER NOT NULL DEFAULT 0,
  kho_ton_evaluated INTEGER NOT NULL DEFAULT 0,
  kho_chua_luan_chuyen_evaluated INTEGER NOT NULL DEFAULT 0,
  first_push_pending_created INTEGER NOT NULL DEFAULT 0,
  second_push_pending_created INTEGER NOT NULL DEFAULT 0,
  third_push_pending_created INTEGER NOT NULL DEFAULT 0,
  escalation_pending_created INTEGER NOT NULL DEFAULT 0,
  total_dispatch_eligible_pending INTEGER NOT NULL DEFAULT 0,
  telegram_scanned INTEGER NOT NULL DEFAULT 0,
  recipients_resolved INTEGER NOT NULL DEFAULT 0,
  interactions_created INTEGER NOT NULL DEFAULT 0,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  send_success INTEGER NOT NULL DEFAULT 0,
  send_failed INTEGER NOT NULL DEFAULT 0,
  exclusion_counts JSONB NULL,
  error_code TEXT NULL,
  error_message_safe TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_dispatch_audits_sync_run
  ON checkpoint_dispatch_audits(sync_run_id) WHERE sync_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_dispatch_audits_checkpoint
  ON checkpoint_dispatch_audits(checkpoint_at);

CREATE OR REPLACE FUNCTION reject_checkpoint_dispatch_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'checkpoint_dispatch_audits records are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS checkpoint_dispatch_audits_immutable ON checkpoint_dispatch_audits;
CREATE TRIGGER checkpoint_dispatch_audits_immutable
  BEFORE UPDATE OR DELETE ON checkpoint_dispatch_audits
  FOR EACH ROW EXECUTE FUNCTION reject_checkpoint_dispatch_audit_mutation();
