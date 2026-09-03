-- LC-C1: a manager decision topic is not a province or a Lane-A escalation
-- topic. Keep this classification explicit so it cannot be accidentally used
-- by the follow-up dispatcher.
ALTER TABLE telegram_pilot_topics
  ADD COLUMN IF NOT EXISTS is_manager_decision BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pilot_topics_group_manager_decision_active
  ON telegram_pilot_topics(group_id)
  WHERE status = 'ACTIVE' AND is_manager_decision = TRUE;
