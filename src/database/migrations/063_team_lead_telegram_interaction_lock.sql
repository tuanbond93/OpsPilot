-- One response per actionable Telegram interaction. Every later reminder is a new row/message and locks independently.
ALTER TABLE telegram_followup_reminders
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS response_code TEXT,
  ADD COLUMN IF NOT EXISTS response_label TEXT,
  ADD COLUMN IF NOT EXISTS responded_by_member_id UUID REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS response_telegram_update_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_telegram_followup_response_update
  ON telegram_followup_reminders(response_telegram_update_id)
  WHERE response_telegram_update_id IS NOT NULL;

CREATE OR REPLACE FUNCTION claim_telegram_followup_response(
  p_reminder_id UUID,
  p_group_id UUID,
  p_message_id BIGINT,
  p_member_id UUID,
  p_update_id BIGINT,
  p_response_code TEXT,
  p_response_label TEXT,
  p_actor TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  representative telegram_followup_reminders%ROWTYPE;
  already_locked BOOLEAN;
BEGIN
  SELECT * INTO representative
  FROM telegram_followup_reminders
  WHERE id=p_reminder_id AND group_id=p_group_id AND telegram_message_id=p_message_id AND status='SENT'
  FOR UPDATE;
  IF NOT FOUND OR NOT (representative.recipient_member_ids ? p_member_id::TEXT) THEN RETURN 'INVALID_TARGET'; END IF;

  PERFORM 1 FROM telegram_followup_reminders
  WHERE group_id=p_group_id AND telegram_message_id=p_message_id AND status='SENT'
  ORDER BY id FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM telegram_followup_reminders WHERE group_id=p_group_id AND telegram_message_id=p_message_id AND responded_at IS NOT NULL) INTO already_locked;
  IF already_locked THEN RETURN 'ALREADY_RESPONDED'; END IF;

  UPDATE telegram_followup_reminders
  SET responded_at=NOW(), response_code=p_response_code, response_label=p_response_label,
      responded_by_member_id=p_member_id, response_telegram_update_id=p_update_id, updated_at=NOW()
  WHERE group_id=p_group_id AND telegram_message_id=p_message_id AND status='SENT';

  INSERT INTO telegram_followup_reminder_events(reminder_id,event_type,actor,metadata)
  SELECT id,'SIGNAL_RECEIVED',p_actor,jsonb_build_object(
    'signal',p_response_code,'responseKind',CASE WHEN p_response_code='OTHER' THEN 'FREE_TEXT_FALLBACK_REQUESTED' ELSE 'STRUCTURED_REASON' END,
    'structuredReason',p_response_code,'followupCaseId',followup_case_id,'reminderStage',reminder_stage,
    'telegramUpdateId',p_update_id,'telegramMessageId',p_message_id)
  FROM telegram_followup_reminders
  WHERE group_id=p_group_id AND telegram_message_id=p_message_id AND status='SENT';
  RETURN 'ACCEPTED';
END;
$$;

REVOKE ALL ON FUNCTION claim_telegram_followup_response(UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_telegram_followup_response(UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT,TEXT) TO service_role;
