-- TG-03: immutable employee feedback explicitly replying to a dispatched Telegram work order.
-- Feedback is evidence only; it must not change execution_work_orders.status.

CREATE TABLE IF NOT EXISTS telegram_work_order_feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES telegram_work_order_dispatches(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  telegram_update_id BIGINT NOT NULL UNIQUE,
  telegram_message_id BIGINT NOT NULL,
  feedback_text TEXT NOT NULL CHECK (char_length(feedback_text) BETWEEN 1 AND 4000),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_work_order_feedbacks_dispatch_time ON telegram_work_order_feedbacks(dispatch_id, received_at ASC);

CREATE OR REPLACE FUNCTION reject_telegram_work_order_feedback_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_work_order_feedbacks records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_work_order_feedbacks_immutable ON telegram_work_order_feedbacks;
CREATE TRIGGER telegram_work_order_feedbacks_immutable BEFORE UPDATE OR DELETE ON telegram_work_order_feedbacks
FOR EACH ROW EXECUTE FUNCTION reject_telegram_work_order_feedback_mutation();
