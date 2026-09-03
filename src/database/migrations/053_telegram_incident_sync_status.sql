-- Per-sync incident status evidence. Separate from reminder ladder: a status
-- update never advances follow-up state and is idempotent for one sync/case.
CREATE TABLE IF NOT EXISTS telegram_incident_status_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  sync_run_id UUID NOT NULL REFERENCES sync_runs(id) ON DELETE RESTRICT,
  update_kind TEXT NOT NULL CHECK (update_kind IN ('ACTIVE','RESOLVED')),
  changed BOOLEAN NOT NULL,
  previous_affected_order_count INTEGER NULL,
  current_affected_order_count INTEGER NOT NULL CHECK (current_affected_order_count >= 0),
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  message_thread_id BIGINT NOT NULL CHECK (message_thread_id > 0),
  telegram_message_id BIGINT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(followup_case_id, sync_run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_incident_one_resolved_notice
  ON telegram_incident_status_updates(followup_case_id) WHERE update_kind='RESOLVED' AND status='SENT';
CREATE INDEX IF NOT EXISTS telegram_incident_status_sync
  ON telegram_incident_status_updates(sync_run_id, status);

CREATE TABLE IF NOT EXISTS telegram_sync_status_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id UUID NOT NULL UNIQUE REFERENCES sync_runs(id) ON DELETE RESTRICT,
  telegram_chat_id BIGINT NOT NULL,
  message_thread_id BIGINT NOT NULL CHECK (message_thread_id > 0),
  telegram_message_id BIGINT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  active_cases INTEGER NOT NULL DEFAULT 0,
  changed_cases INTEGER NOT NULL DEFAULT 0,
  unchanged_cases INTEGER NOT NULL DEFAULT 0,
  resolved_cases INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE telegram_incident_status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_sync_status_reports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE telegram_incident_status_updates IS
  'Telegram status heartbeat per MB3 follow-up case and sync; never advances the reminder state machine.';
COMMENT ON TABLE telegram_sync_status_reports IS
  'Exactly one Manager heartbeat per completed sync, including zero-change cycles.';
