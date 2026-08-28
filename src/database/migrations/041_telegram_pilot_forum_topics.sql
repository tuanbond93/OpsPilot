-- TG-07: Telegram forum-topic routing for the Miền Bắc 3 follow-up pilot.
-- A topic is only discovered from an inbound update; Telegram Bot API cannot list
-- historic forum topics, so the bot never guesses a message_thread_id.

CREATE TABLE IF NOT EXISTS telegram_pilot_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  message_thread_id BIGINT NOT NULL CHECK (message_thread_id > 0),
  topic_title TEXT NOT NULL DEFAULT '',
  province_name TEXT NULL,
  is_escalation BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mapped_at TIMESTAMPTZ NULL,
  mapped_by TEXT NULL,
  UNIQUE(group_id, message_thread_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pilot_topics_group_province_active
  ON telegram_pilot_topics(group_id, province_name)
  WHERE status = 'ACTIVE' AND province_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pilot_topics_group_escalation_active
  ON telegram_pilot_topics(group_id)
  WHERE status = 'ACTIVE' AND is_escalation = TRUE;

ALTER TABLE telegram_followup_reminders
  ADD COLUMN IF NOT EXISTS message_thread_id BIGINT NULL CHECK (message_thread_id IS NULL OR message_thread_id > 0);

CREATE INDEX IF NOT EXISTS idx_telegram_followup_reminders_group_thread
  ON telegram_followup_reminders(group_id, message_thread_id, created_at DESC);
