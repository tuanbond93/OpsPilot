-- TG-06: Explicit manager-triggered Telegram delivery for a follow-up first push.
-- No work-order or operational action is created by this migration.

CREATE TABLE IF NOT EXISTS telegram_followup_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  telegram_message_id BIGINT NULL,
  recipient_member_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recipient_member_ids) = 'array' AND jsonb_array_length(recipient_member_ids) BETWEEN 1 AND 30),
  idempotency_key TEXT NOT NULL UNIQUE,
  sent_by TEXT NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_followup_reminders_case_created
  ON telegram_followup_reminders(followup_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_followup_reminder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID NOT NULL REFERENCES telegram_followup_reminders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('REMINDER_REQUESTED', 'REMINDER_SENT', 'REMINDER_FAILED')),
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION reject_telegram_followup_reminder_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_followup_reminder_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_followup_reminder_events_immutable ON telegram_followup_reminder_events;
CREATE TRIGGER telegram_followup_reminder_events_immutable
  BEFORE UPDATE OR DELETE ON telegram_followup_reminder_events
  FOR EACH ROW EXECUTE FUNCTION reject_telegram_followup_reminder_event_mutation();
