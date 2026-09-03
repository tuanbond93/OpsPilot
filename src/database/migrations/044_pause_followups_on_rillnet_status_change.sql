-- Stop automated reminder escalation when the Rillnet status distribution for
-- an already-contacted incident changes. A manager must explicitly resume the
-- follow-up; this never sends a Telegram message by itself.

ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'RILLNET_CHANGE_PAUSED';

ALTER TABLE followup_cases
  ADD COLUMN IF NOT EXISTS current_rillnet_status_signature TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_action_rillnet_status_signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS rillnet_change_summary TEXT NULL,
  ADD COLUMN IF NOT EXISTS rillnet_changed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_followup_cases_rillnet_change_paused
  ON followup_cases (rillnet_changed_at DESC)
  WHERE current_state = 'RILLNET_CHANGE_PAUSED';
