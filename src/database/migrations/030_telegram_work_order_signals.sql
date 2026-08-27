-- TG-04: immutable acknowledgement signals from Telegram inline buttons.
-- Signals are operational evidence only and never transition a work order.

CREATE TABLE IF NOT EXISTS telegram_work_order_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES telegram_work_order_dispatches(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  telegram_update_id BIGINT NOT NULL UNIQUE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('ACKNOWLEDGED', 'NEEDS_SUPPORT', 'PROGRESS_UPDATED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_work_order_signals_dispatch_time ON telegram_work_order_signals(dispatch_id, received_at ASC);

CREATE OR REPLACE FUNCTION reject_telegram_work_order_signal_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_work_order_signals records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_work_order_signals_immutable ON telegram_work_order_signals;
CREATE TRIGGER telegram_work_order_signals_immutable BEFORE UPDATE OR DELETE ON telegram_work_order_signals
FOR EACH ROW EXECUTE FUNCTION reject_telegram_work_order_signal_mutation();
