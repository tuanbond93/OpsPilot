-- A Rillnet status change remains visible and is sent to the Manager Decision
-- topic for explicit human classification. Requests are idempotent per case +
-- observed status signature; the callback transaction also accepts the new
-- signature as the next comparison baseline so the case cannot immediately
-- pause again on the same evidence.

CREATE TABLE IF NOT EXISTS telegram_rillnet_review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  message_thread_id BIGINT NOT NULL CHECK (message_thread_id > 0),
  telegram_message_id BIGINT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CONFIRMED')),
  proposed_outcome TEXT NOT NULL CHECK (proposed_outcome IN ('SUCCESS', 'FAILED', 'CONTINUE')),
  manager_outcome TEXT NULL CHECK (manager_outcome IS NULL OR manager_outcome IN ('SUCCESS', 'FAILED', 'CONTINUE')),
  rillnet_status_signature TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  manager_member_id UUID NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  telegram_update_id BIGINT NULL UNIQUE,
  created_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_rillnet_review_pending
  ON telegram_rillnet_review_requests(status, created_at DESC);

ALTER TABLE telegram_rillnet_review_requests ENABLE ROW LEVEL SECURITY;

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

  v_new_state := CASE WHEN v_outcome = 'SUCCESS' THEN 'RESOLVED'::followup_state_enum ELSE 'FOLLOWING_UP'::followup_state_enum END;
  UPDATE followup_cases SET
    current_state = v_new_state,
    last_checked_at = v_now,
    last_action_confirmed_at = v_now,
    last_action_rillnet_status_signature = current_rillnet_status_signature,
    rillnet_change_summary = NULL,
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
