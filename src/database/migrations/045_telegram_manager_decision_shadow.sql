-- LC-C1: manager observations for SHADOW decisions. These rows never change
-- decisions.decision_status and are intentionally separate from work orders.
CREATE TABLE IF NOT EXISTS telegram_decision_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  triage_audit_id UUID NULL REFERENCES incident_triage_evaluations(id) ON DELETE RESTRICT,
  manager_group_id UUID NOT NULL REFERENCES telegram_pilot_groups(id) ON DELETE RESTRICT,
  manager_scope_code TEXT NOT NULL,
  telegram_chat_id BIGINT NOT NULL,
  message_thread_id BIGINT NOT NULL CHECK (message_thread_id > 0),
  telegram_message_id BIGINT NULL,
  source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','RESPONDED','STALE','FAILED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  failure_reason TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(decision_id),
  CHECK ((status = 'SENT' AND telegram_message_id IS NOT NULL) OR status <> 'SENT')
);

CREATE TABLE IF NOT EXISTS telegram_decision_response_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES telegram_decision_requests(id) ON DELETE RESTRICT,
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  manager_member_id UUID NOT NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  telegram_user_id BIGINT NOT NULL,
  telegram_update_id BIGINT NOT NULL UNIQUE,
  response TEXT NOT NULL CHECK (response IN ('APPROVE','REJECT','VIEW_EVIDENCE')),
  source_fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_decision_one_terminal_response
  ON telegram_decision_response_events(request_id) WHERE response IN ('APPROVE','REJECT');
CREATE INDEX IF NOT EXISTS telegram_decision_requests_runtime_lookup
  ON telegram_decision_requests(id, status, telegram_chat_id, message_thread_id, telegram_message_id);

CREATE OR REPLACE FUNCTION reject_telegram_decision_response_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_decision_response_events records are immutable' USING ERRCODE = '55000'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_decision_response_events_immutable ON telegram_decision_response_events;
CREATE TRIGGER telegram_decision_response_events_immutable BEFORE UPDATE OR DELETE ON telegram_decision_response_events
FOR EACH ROW EXECUTE FUNCTION reject_telegram_decision_response_event_mutation();

-- Locks the request, rejects stale/non-shadow/non-PASS decisions, and relies on
-- unique indexes for update and terminal-response idempotency under concurrency.
CREATE OR REPLACE FUNCTION record_telegram_decision_shadow_response(p_payload JSONB) RETURNS JSONB AS $$
DECLARE r telegram_decision_requests%ROWTYPE; d decisions%ROWTYPE; event_id UUID; action TEXT := p_payload->>'response';
BEGIN
  SELECT * INTO r FROM telegram_decision_requests WHERE id=(p_payload->>'requestId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DECISION_REQUEST_NOT_FOUND'; END IF;
  SELECT * INTO d FROM decisions WHERE id=r.decision_id FOR UPDATE;
  IF d.decision_mode <> 'SHADOW' THEN RAISE EXCEPTION 'DECISION_NOT_SHADOW'; END IF;
  IF r.status IN ('STALE','FAILED') THEN RAISE EXCEPTION 'DECISION_REQUEST_UNAVAILABLE'; END IF;
  IF r.source_fingerprint <> p_payload->>'sourceFingerprint' THEN UPDATE telegram_decision_requests SET status='STALE',updated_at=NOW() WHERE id=r.id; RAISE EXCEPTION 'DECISION_REQUEST_STALE'; END IF;
  IF COALESCE(d.source_links->>'triageRoute','') <> 'AI_DECISION_REQUIRED' OR COALESCE(d.source_links->>'criticVerdict','') <> 'PASS' THEN RAISE EXCEPTION 'DECISION_GATE_INVALID'; END IF;
  INSERT INTO telegram_decision_response_events(request_id,decision_id,manager_member_id,telegram_user_id,telegram_update_id,response,source_fingerprint,idempotency_key,metadata)
  VALUES(r.id,d.id,(p_payload->>'memberId')::uuid,(p_payload->>'telegramUserId')::bigint,(p_payload->>'telegramUpdateId')::bigint,action,r.source_fingerprint,p_payload->>'idempotencyKey',COALESCE(p_payload->'metadata','{}'::jsonb))
  ON CONFLICT (telegram_update_id) DO NOTHING RETURNING id INTO event_id;
  IF event_id IS NULL THEN RETURN jsonb_build_object('idempotent',true,'status',r.status); END IF;
  IF action IN ('APPROVE','REJECT') THEN UPDATE telegram_decision_requests SET status='RESPONDED',updated_at=NOW() WHERE id=r.id; END IF;
  RETURN jsonb_build_object('idempotent',false,'status',CASE WHEN action IN ('APPROVE','REJECT') THEN 'RESPONDED' ELSE r.status END);
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION record_telegram_decision_shadow_response(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_telegram_decision_shadow_response(JSONB) TO service_role;
