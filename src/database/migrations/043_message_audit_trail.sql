-- OpsPilot Database Migration 043: Message Audit Trail & Conversation Events
-- Provides durable, queryable audit of all notification deliveries and employee conversations.

-- 1. Message deliveries audit trail
CREATE TABLE IF NOT EXISTS message_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NULL,
  incident_key TEXT NULL,
  followup_case_id UUID NULL,
  work_order_id UUID NULL,
  event_type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'OUTBOUND'
    CHECK (direction IN ('OUTBOUND', 'INBOUND', 'SYSTEM')),
  
  -- Recipient info
  recipient_member_id UUID NULL REFERENCES telegram_pilot_members(id) ON DELETE SET NULL,
  recipient_telegram_user_id BIGINT NULL,
  recipient_chat_id TEXT NULL,
  
  -- Destination info
  destination_type TEXT NOT NULL DEFAULT 'GROUP_TOPIC'
    CHECK (destination_type IN ('GROUP_TOPIC', 'PRIVATE_DM', 'MIRROR')),
  province TEXT NULL,
  warehouse TEXT NULL,
  scope TEXT NULL,
  
  -- Content
  message_text TEXT NULL CHECK (message_text IS NULL OR char_length(message_text) <= 8000),
  message_preview TEXT NULL CHECK (message_preview IS NULL OR char_length(message_preview) <= 500),
  
  -- Telegram result
  telegram_message_id BIGINT NULL,
  telegram_thread_id BIGINT NULL,
  
  -- Delivery status
  delivery_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_status IN ('PENDING', 'SUCCESS', 'FAILED', 'FALLBACK', 'SKIPPED', 'SIMULATED')),
  error_code TEXT NULL,
  error_message TEXT NULL,
  
  -- Routing info
  routing_mode TEXT NULL,
  routing_reason TEXT NULL,
  idempotency_key TEXT NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_deliveries_incident
  ON message_deliveries(incident_id, created_at DESC)
  WHERE incident_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_deliveries_incident_key
  ON message_deliveries(incident_key, created_at DESC)
  WHERE incident_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_deliveries_recipient
  ON message_deliveries(recipient_member_id, created_at DESC)
  WHERE recipient_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_deliveries_status
  ON message_deliveries(delivery_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_deliveries_idempotency
  ON message_deliveries(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_deliveries_work_order
  ON message_deliveries(work_order_id, created_at DESC)
  WHERE work_order_id IS NOT NULL;

-- 2. Conversation events (employee replies as first-class events)
CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NULL,
  incident_key TEXT NULL,
  member_id UUID NULL REFERENCES telegram_pilot_members(id) ON DELETE SET NULL,
  telegram_user_id BIGINT NULL,
  telegram_message_id BIGINT NULL,
  direction TEXT NOT NULL DEFAULT 'INBOUND'
    CHECK (direction IN ('OUTBOUND', 'INBOUND', 'SYSTEM')),
  text TEXT NULL CHECK (text IS NULL OR char_length(text) <= 8000),
  reply_to_message_id BIGINT NULL,
  reply_to_delivery_id UUID NULL REFERENCES message_deliveries(id) ON DELETE SET NULL,
  
  -- AI analysis results
  classification TEXT NULL,
  extracted_cause TEXT NULL,
  extracted_commitment TEXT NULL,
  ai_result JSONB NULL,
  
  -- Source tracking
  source_chat_type TEXT NULL CHECK (source_chat_type IS NULL OR source_chat_type IN ('private', 'group', 'supergroup')),
  telegram_update_id BIGINT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_incident
  ON conversation_events(incident_id, created_at DESC)
  WHERE incident_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_member
  ON conversation_events(member_id, created_at DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_reply_to
  ON conversation_events(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- Immutable audit trail
CREATE OR REPLACE FUNCTION reject_message_delivery_deletion() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'message_deliveries records cannot be deleted' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS message_deliveries_no_delete ON message_deliveries;
CREATE TRIGGER message_deliveries_no_delete
  BEFORE DELETE ON message_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_message_delivery_deletion();

CREATE OR REPLACE FUNCTION reject_conversation_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'conversation_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversation_events_immutable ON conversation_events;
CREATE TRIGGER conversation_events_immutable
  BEFORE UPDATE OR DELETE ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION reject_conversation_event_mutation();
