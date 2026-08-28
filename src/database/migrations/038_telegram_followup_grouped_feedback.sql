-- TG-04: a reply or button on an aggregated follow-up message is immutable
-- evidence for every case represented by that Telegram message.

ALTER TABLE telegram_followup_reminder_events
  DROP CONSTRAINT IF EXISTS telegram_followup_reminder_events_event_type_check;

ALTER TABLE telegram_followup_reminder_events
  ADD CONSTRAINT telegram_followup_reminder_events_event_type_check
  CHECK (event_type IN (
    'REMINDER_REQUESTED',
    'REMINDER_SENT',
    'REMINDER_FAILED',
    'FEEDBACK_RECEIVED',
    'SIGNAL_RECEIVED'
  ));
