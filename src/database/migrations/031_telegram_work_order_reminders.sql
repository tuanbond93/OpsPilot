-- TG-05A: Manager-initiated Telegram reminders. Reminders are delivery/audit only;
-- they never mutate execution_work_orders or decisions.

CREATE TABLE IF NOT EXISTS telegram_work_order_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES telegram_work_order_dispatches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  sent_by TEXT NOT NULL CHECK (NULLIF(BTRIM(sent_by), '') IS NOT NULL),
  telegram_message_id BIGINT NULL,
  sent_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_work_order_reminder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID NOT NULL REFERENCES telegram_work_order_reminders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('REMINDER_REQUESTED', 'REMINDER_SENT', 'REMINDER_FAILED')),
  actor TEXT NOT NULL CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_work_order_reminders_dispatch_time
  ON telegram_work_order_reminders(dispatch_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_telegram_work_order_reminder_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_work_order_reminder_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_work_order_reminder_events_immutable ON telegram_work_order_reminder_events;
CREATE TRIGGER telegram_work_order_reminder_events_immutable BEFORE UPDATE OR DELETE ON telegram_work_order_reminder_events
FOR EACH ROW EXECUTE FUNCTION reject_telegram_work_order_reminder_event_mutation();
