-- TG-01: Group roster and inbound Telegram audit only.
-- This migration does not dispatch work orders or mutate decision/work-order state.

CREATE TABLE IF NOT EXISTS telegram_pilot_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_pilot_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  telegram_user_id BIGINT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT NULL,
  warehouse_name TEXT NULL,
  pilot_role TEXT NOT NULL DEFAULT 'OPERATOR' CHECK (pilot_role IN ('OPERATOR', 'MANAGER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mapped_at TIMESTAMPTZ NULL,
  mapped_by TEXT NULL,
  UNIQUE(group_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS telegram_pilot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_update_id BIGINT NOT NULL UNIQUE,
  group_id UUID NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  member_id UUID NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('JOIN_REQUEST', 'FREE_TEXT_FEEDBACK', 'CALLBACK_RECEIVED', 'UNSUPPORTED_UPDATE')),
  telegram_message_id BIGINT NULL,
  reply_to_message_id BIGINT NULL,
  message_text TEXT NULL CHECK (message_text IS NULL OR char_length(message_text) <= 4000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_pilot_members_group_status ON telegram_pilot_members(group_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_pilot_events_member_time ON telegram_pilot_events(member_id, received_at DESC);

CREATE OR REPLACE FUNCTION reject_telegram_pilot_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_pilot_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_pilot_events_immutable ON telegram_pilot_events;
CREATE TRIGGER telegram_pilot_events_immutable BEFORE UPDATE OR DELETE ON telegram_pilot_events
FOR EACH ROW EXECUTE FUNCTION reject_telegram_pilot_event_mutation();
