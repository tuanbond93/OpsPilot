-- TG-07: Three-step Telegram follow-up ladder for the Miền Bắc 3 pilot.
-- Delivery is still only a communication record; it never executes an operational action.

ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'THIRD_PUSH_PENDING';
ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'THIRD_PUSH_SENT';

ALTER TABLE telegram_followup_reminders
  ADD COLUMN IF NOT EXISTS reminder_stage TEXT NOT NULL DEFAULT 'FIRST'
  CHECK (reminder_stage IN ('FIRST', 'SECOND', 'THIRD', 'ESCALATION'));

CREATE INDEX IF NOT EXISTS idx_telegram_followup_reminders_case_stage
  ON telegram_followup_reminders(followup_case_id, reminder_stage, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chk_notification_actions_action_type') THEN
    ALTER TABLE notification_actions DROP CONSTRAINT chk_notification_actions_action_type;
    ALTER TABLE notification_actions ADD CONSTRAINT chk_notification_actions_action_type
      CHECK (action_type IN ('FIRST_PUSH', 'SECOND_PUSH', 'THIRD_PUSH', 'ESCALATION', 'ROOTCAUSE_SUMMARY', 'DAILY_REPORT', 'WARNING', 'SYSTEM', 'CUSTOM'));
  END IF;
END $$;
