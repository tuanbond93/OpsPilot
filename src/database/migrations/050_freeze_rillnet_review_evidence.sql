-- Freeze the exact evidence that caused a Rillnet review. Historical review
-- requests created before this migration are invalidated because their live
-- follow-up fields were mutable and cannot be trusted as review evidence.

ALTER TABLE followup_cases
  ADD COLUMN IF NOT EXISTS rillnet_review_before_signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS rillnet_review_after_signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS rillnet_review_detected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rillnet_review_snapshot_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS rillnet_review_order_codes JSONB NULL;

ALTER TABLE telegram_rillnet_review_requests
  ADD COLUMN IF NOT EXISTS before_signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS after_signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS snapshot_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS order_codes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE telegram_rillnet_review_requests
  DROP CONSTRAINT IF EXISTS telegram_rillnet_review_requests_status_check;
ALTER TABLE telegram_rillnet_review_requests
  ADD CONSTRAINT telegram_rillnet_review_requests_status_check
  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CONFIRMED', 'INVALIDATED'));

UPDATE telegram_rillnet_review_requests
SET status = 'INVALIDATED',
    failure_reason = 'Invalidated: mutable Rillnet evidence before evidence-freeze migration 050.',
    updated_at = NOW()
WHERE status IN ('PENDING', 'SENT', 'FAILED');

UPDATE followup_cases fc
SET current_state = 'FOLLOWING_UP',
    last_action_rillnet_status_signature = fc.current_rillnet_status_signature,
    rillnet_change_summary = NULL,
    rillnet_changed_at = NULL,
    rillnet_review_before_signature = NULL,
    rillnet_review_after_signature = NULL,
    rillnet_review_detected_at = NULL,
    rillnet_review_snapshot_id = NULL,
    rillnet_review_order_codes = NULL,
    updated_at = NOW()
WHERE fc.current_state = 'RILLNET_CHANGE_PAUSED'
  AND EXISTS (
    SELECT 1 FROM telegram_rillnet_review_requests tr
    WHERE tr.followup_case_id = fc.id AND tr.status = 'INVALIDATED'
  );

CREATE OR REPLACE FUNCTION confirm_telegram_rillnet_review(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request telegram_rillnet_review_requests%ROWTYPE;
  v_outcome TEXT := upper(COALESCE(p_payload->>'outcome', ''));
  v_now TIMESTAMPTZ := NOW();
  v_new_state followup_state_enum;
BEGIN
  IF v_outcome NOT IN ('SUCCESS', 'FAILED', 'CONTINUE') THEN
    RAISE EXCEPTION 'Invalid manager outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_request FROM telegram_rillnet_review_requests
    WHERE id = (p_payload->>'requestId')::UUID FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review request not found' USING ERRCODE = 'P0002'; END IF;
  IF v_request.status = 'CONFIRMED' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'outcome', v_request.manager_outcome);
  END IF;
  IF v_request.status <> 'SENT' THEN RAISE EXCEPTION 'Review request is not active' USING ERRCODE = '55000'; END IF;
  IF v_request.before_signature IS NULL OR v_request.after_signature IS NULL
     OR v_request.before_signature = v_request.after_signature THEN
    RAISE EXCEPTION 'Review evidence is missing or unchanged' USING ERRCODE = '55000';
  END IF;

  v_new_state := CASE WHEN v_outcome = 'SUCCESS' THEN 'RESOLVED'::followup_state_enum ELSE 'FOLLOWING_UP'::followup_state_enum END;
  UPDATE followup_cases SET
    current_state = v_new_state,
    last_checked_at = v_now,
    last_action_confirmed_at = v_now,
    last_action_rillnet_status_signature = v_request.after_signature,
    rillnet_change_summary = NULL,
    rillnet_changed_at = NULL,
    rillnet_review_before_signature = NULL,
    rillnet_review_after_signature = NULL,
    rillnet_review_detected_at = NULL,
    rillnet_review_snapshot_id = NULL,
    rillnet_review_order_codes = NULL,
    resolved_at = CASE WHEN v_outcome = 'SUCCESS' THEN v_now ELSE resolved_at END,
    updated_at = v_now
  WHERE id = v_request.followup_case_id AND current_state = 'RILLNET_CHANGE_PAUSED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Follow-up case is no longer awaiting review' USING ERRCODE = '55000'; END IF;

  UPDATE telegram_rillnet_review_requests SET
    status = 'CONFIRMED', manager_outcome = v_outcome,
    manager_member_id = (p_payload->>'memberId')::UUID,
    telegram_update_id = (p_payload->>'telegramUpdateId')::BIGINT,
    reviewed_at = v_now, updated_at = v_now
  WHERE id = v_request.id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'outcome', v_outcome, 'newState', v_new_state);
END;
$$;

REVOKE ALL ON FUNCTION confirm_telegram_rillnet_review(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_telegram_rillnet_review(JSONB) TO service_role;
