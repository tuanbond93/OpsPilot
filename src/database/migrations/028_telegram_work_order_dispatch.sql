-- TG-02: Manager-authorized Telegram delivery for an existing execution work order.
-- This records delivery only. Telegram replies must not mutate work-order state.

CREATE TABLE IF NOT EXISTS telegram_work_order_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES execution_work_orders(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  telegram_message_id BIGINT NULL,
  recipient_member_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipient_member_ids) = 'array' AND jsonb_array_length(recipient_member_ids) BETWEEN 1 AND 30),
  idempotency_key TEXT NOT NULL UNIQUE,
  sent_by TEXT NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(work_order_id, group_id)
);

CREATE TABLE IF NOT EXISTS telegram_work_order_dispatch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES telegram_work_order_dispatches(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('DISPATCH_REQUESTED', 'DISPATCH_SENT', 'DISPATCH_FAILED')),
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_work_order_dispatches_work_order ON telegram_work_order_dispatches(work_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_telegram_work_order_dispatch_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_work_order_dispatch_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_work_order_dispatch_events_immutable ON telegram_work_order_dispatch_events;
CREATE TRIGGER telegram_work_order_dispatch_events_immutable BEFORE UPDATE OR DELETE ON telegram_work_order_dispatch_events
FOR EACH ROW EXECUTE FUNCTION reject_telegram_work_order_dispatch_event_mutation();
