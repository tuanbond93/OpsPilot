-- Gate 2: durable one-to-one capacity case -> Decision Core -> manager request bridge.
ALTER TABLE near_term_capacity_cases
  ADD COLUMN IF NOT EXISTS decision_id UUID NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS decision_request_id UUID NULL REFERENCES telegram_decision_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_fingerprint TEXT NULL;
ALTER TABLE telegram_decision_requests
  ADD COLUMN IF NOT EXISTS capacity_case_id UUID NULL REFERENCES near_term_capacity_cases(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_decision_per_near_term_capacity_case ON near_term_capacity_cases(decision_id) WHERE decision_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_manager_request_per_near_term_capacity_case ON telegram_decision_requests(capacity_case_id) WHERE capacity_case_id IS NOT NULL;

CREATE OR REPLACE FUNCTION record_near_term_capacity_decision_response(p_payload JSONB) RETURNS JSONB AS $$
DECLARE r telegram_decision_requests%ROWTYPE; d decisions%ROWTYPE; c near_term_capacity_cases%ROWTYPE; prior TEXT; action TEXT := p_payload->>'response'; event_id UUID;
BEGIN
  SELECT * INTO r FROM telegram_decision_requests WHERE id=(p_payload->>'requestId')::uuid FOR UPDATE;
  IF NOT FOUND OR r.capacity_case_id IS NULL THEN RAISE EXCEPTION 'CAPACITY_DECISION_REQUEST_NOT_FOUND'; END IF;
  SELECT * INTO c FROM near_term_capacity_cases WHERE id=r.capacity_case_id FOR UPDATE;
  SELECT * INTO d FROM decisions WHERE id=r.decision_id FOR UPDATE;
  IF r.status <> 'SENT' OR d.decision_mode <> 'HUMAN_APPROVAL' OR d.decision_status <> 'READY_FOR_REVIEW' OR d.source_links->>'sourceType' <> 'NEAR_TERM_CAPACITY' THEN
    RETURN jsonb_build_object('accepted',false,'duplicate',true,'decisionStatus',d.decision_status);
  END IF;
  IF r.source_fingerprint <> p_payload->>'sourceFingerprint' OR c.source_fingerprint <> r.source_fingerprint THEN RAISE EXCEPTION 'CAPACITY_DECISION_STALE'; END IF;
  SELECT id INTO event_id FROM telegram_decision_response_events WHERE request_id=r.id AND response IN ('APPROVE','REJECT') LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('accepted',false,'duplicate',true,'decisionStatus',d.decision_status); END IF;
  INSERT INTO telegram_decision_response_events(request_id,decision_id,manager_member_id,telegram_user_id,telegram_update_id,response,source_fingerprint,idempotency_key,metadata)
  VALUES(r.id,d.id,(p_payload->>'memberId')::uuid,(p_payload->>'telegramUserId')::bigint,(p_payload->>'telegramUpdateId')::bigint,action,r.source_fingerprint,p_payload->>'idempotencyKey',COALESCE(p_payload->'metadata','{}'::jsonb));
  prior := d.decision_status;
  UPDATE decisions SET decision_status=CASE WHEN action='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END, updated_at=NOW(),
    approved_by=CASE WHEN action='APPROVE' THEN p_payload->>'actor' ELSE NULL END, approved_at=CASE WHEN action='APPROVE' THEN NOW() ELSE NULL END,
    rejected_by=CASE WHEN action='REJECT' THEN p_payload->>'actor' ELSE NULL END, rejected_at=CASE WHEN action='REJECT' THEN NOW() ELSE NULL END,
    reject_reason=CASE WHEN action='REJECT' THEN 'MANAGER_REJECTED_TELEGRAM' ELSE NULL END WHERE id=d.id;
  INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
  VALUES(d.id, 'capacity-manager-response:' || r.id, p_payload->>'actor', prior, CASE WHEN action='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,
    jsonb_build_object('capacityCaseId',c.id,'telegramRequestId',r.id,'telegramUserSafeRef',p_payload->>'memberId'));
  UPDATE telegram_decision_requests SET status='RESPONDED', updated_at=NOW() WHERE id=r.id;
  UPDATE near_term_capacity_cases SET status='CLOSED', active=false, updated_at=NOW() WHERE id=c.id;
  INSERT INTO near_term_capacity_events(case_id,event_type,actor,payload) VALUES(c.id, CASE WHEN action='APPROVE' THEN 'MANAGER_APPROVED' ELSE 'MANAGER_REJECTED' END, p_payload->>'actor', jsonb_build_object('decisionId',d.id,'decisionRequestId',r.id));
  RETURN jsonb_build_object('accepted',true,'duplicate',false,'decisionStatus',CASE WHEN action='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END);
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION record_near_term_capacity_decision_response(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_near_term_capacity_decision_response(JSONB) TO service_role;
