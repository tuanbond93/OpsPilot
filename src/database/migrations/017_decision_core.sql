-- OpsPilot Migration 017: Decision Core (independent from P15-B.1 financial logic)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  incident_id UUID NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  root_cause_run_id TEXT NULL,
  followup_case_id UUID NULL REFERENCES followup_cases(id) ON DELETE RESTRICT,
  action_id UUID NULL REFERENCES notification_actions(id) ON DELETE RESTRICT,
  planner_run_id UUID NULL REFERENCES planner_runs(id) ON DELETE RESTRICT,
  source_links JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fingerprint TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  problem TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(alternatives) = 'array'),
  confidence NUMERIC(5,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  decision_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (decision_status IN (
    'DRAFT','READY_FOR_REVIEW','APPROVED','REJECTED','EXECUTED','OUTCOME_PENDING','SUCCESS','FAILURE','INCONCLUSIVE'
  )),
  decision_mode TEXT NOT NULL CHECK (decision_mode IN ('SHADOW','HUMAN_APPROVAL')),
  financial_impact JSONB NOT NULL DEFAULT '{"status":"NOT_EVALUATED"}'::jsonb
    CHECK (financial_impact = '{"status":"NOT_EVALUATED"}'::jsonb),
  decision_deadline TIMESTAMPTZ NULL,
  approved_by TEXT NULL, approved_at TIMESTAMPTZ NULL,
  rejected_by TEXT NULL, rejected_at TIMESTAMPTZ NULL, reject_reason TEXT NULL,
  executed_by TEXT NULL, executed_at TIMESTAMPTZ NULL, execution_reference TEXT NULL,
  outcome_status TEXT NULL CHECK (outcome_status IS NULL OR outcome_status IN ('SUCCESS','FAILURE','INCONCLUSIVE')),
  outcome_recorded_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (decision_status <> 'REJECTED' OR NULLIF(BTRIM(reject_reason), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS decision_evidence_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE RESTRICT,
  snapshot JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decision_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_status TEXT NULL,
  new_status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(decision_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS decision_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILURE','INCONCLUSIVE')),
  observed_outcome TEXT NOT NULL CHECK (NULLIF(BTRIM(observed_outcome), '') IS NOT NULL),
  measured_at TIMESTAMPTZ NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  inconclusive_reason TEXT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(decision_id, idempotency_key),
  CHECK (status <> 'INCONCLUSIVE' OR NULLIF(BTRIM(inconclusive_reason), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(decision_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_audit_decision_time ON decision_audit_events(decision_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision_time ON decision_outcomes(decision_id, recorded_at);

CREATE OR REPLACE FUNCTION reject_immutable_decision_record() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_evidence_immutable ON decision_evidence_snapshots;
CREATE TRIGGER decision_evidence_immutable BEFORE UPDATE OR DELETE ON decision_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_immutable_decision_record();
DROP TRIGGER IF EXISTS decision_audit_immutable ON decision_audit_events;
CREATE TRIGGER decision_audit_immutable BEFORE UPDATE OR DELETE ON decision_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_decision_record();
DROP TRIGGER IF EXISTS decision_outcomes_immutable ON decision_outcomes;
CREATE TRIGGER decision_outcomes_immutable BEFORE UPDATE OR DELETE ON decision_outcomes
FOR EACH ROW EXECUTE FUNCTION reject_immutable_decision_record();

CREATE OR REPLACE FUNCTION create_decision_core(p_payload JSONB) RETURNS JSONB AS $$
DECLARE d decisions%ROWTYPE; now_at TIMESTAMPTZ := NOW();
BEGIN
  IF p_payload->>'mode' = 'AUTONOMOUS' THEN RAISE EXCEPTION 'AUTONOMOUS_MODE_BLOCKED'; END IF;
  SELECT * INTO d FROM decisions WHERE source_fingerprint = p_payload->>'sourceFingerprint'
    OR idempotency_key = p_payload->>'idempotencyKey' LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('decision', to_jsonb(d), 'idempotent', true); END IF;

  INSERT INTO decisions(source_type,source_id,incident_id,root_cause_run_id,followup_case_id,action_id,planner_run_id,
    source_links,source_fingerprint,idempotency_key,problem,root_cause,recommended_action,alternatives,confidence,
    risk_level,decision_mode,decision_deadline)
  VALUES(p_payload#>>'{sourceLinks,sourceType}',p_payload#>>'{sourceLinks,sourceId}',
    NULLIF(p_payload#>>'{sourceLinks,incidentId}','')::uuid,p_payload#>>'{sourceLinks,rootCauseRunId}',
    NULLIF(p_payload#>>'{sourceLinks,followupCaseId}','')::uuid,NULLIF(p_payload#>>'{sourceLinks,actionId}','')::uuid,
    NULLIF(p_payload#>>'{sourceLinks,plannerRunId}','')::uuid,p_payload->'sourceLinks',p_payload->>'sourceFingerprint',
    p_payload->>'idempotencyKey',p_payload->>'problem',p_payload->>'rootCause',p_payload->>'recommendedAction',
    COALESCE(p_payload->'alternatives','[]'::jsonb),(p_payload->>'confidence')::numeric,p_payload->>'riskLevel',
    p_payload->>'mode',NULLIF(p_payload->>'decisionDeadline','')::timestamptz)
  ON CONFLICT DO NOTHING RETURNING * INTO d;
  IF NOT FOUND THEN
    SELECT * INTO d FROM decisions WHERE source_fingerprint=p_payload->>'sourceFingerprint'
      OR idempotency_key=p_payload->>'idempotencyKey' LIMIT 1;
    RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',true);
  END IF;
  INSERT INTO decision_evidence_snapshots(decision_id,snapshot,captured_at)
    VALUES(d.id,p_payload->'evidence',COALESCE(NULLIF(p_payload#>>'{evidence,capturedAt}','')::timestamptz,now_at));
  INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
    VALUES(d.id,p_payload->>'idempotencyKey',p_payload->>'actor',NULL,'DRAFT','{"event":"DECISION_CREATED"}');
  RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION transition_decision_core(p_payload JSONB) RETURNS JSONB AS $$
DECLARE d decisions%ROWTYPE; existing_event UUID; allowed BOOLEAN := false; target TEXT := p_payload->>'targetStatus'; prior TEXT; now_at TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO d FROM decisions WHERE id=(p_payload->>'decisionId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DECISION_NOT_FOUND'; END IF;
  SELECT id INTO existing_event FROM decision_audit_events WHERE decision_id=d.id AND idempotency_key=p_payload->>'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',true); END IF;
  allowed := (d.decision_status='DRAFT' AND target='READY_FOR_REVIEW') OR
    (d.decision_status='READY_FOR_REVIEW' AND target IN ('APPROVED','REJECTED')) OR
    (d.decision_status='APPROVED' AND target='EXECUTED') OR
    (d.decision_status='EXECUTED' AND target='OUTCOME_PENDING') OR
    (d.decision_status='OUTCOME_PENDING' AND target IN ('SUCCESS','FAILURE','INCONCLUSIVE'));
  IF NOT allowed THEN RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', d.decision_status,target; END IF;
  IF target='REJECTED' AND NULLIF(BTRIM(p_payload->>'rejectReason'),'') IS NULL THEN RAISE EXCEPTION 'REJECT_REASON_REQUIRED'; END IF;
  prior := d.decision_status;
  UPDATE decisions SET decision_status=target,updated_at=now_at,
    approved_by=CASE WHEN target='APPROVED' THEN p_payload->>'actor' ELSE approved_by END,
    approved_at=CASE WHEN target='APPROVED' THEN now_at ELSE approved_at END,
    rejected_by=CASE WHEN target='REJECTED' THEN p_payload->>'actor' ELSE rejected_by END,
    rejected_at=CASE WHEN target='REJECTED' THEN now_at ELSE rejected_at END,
    reject_reason=CASE WHEN target='REJECTED' THEN p_payload->>'rejectReason' ELSE reject_reason END,
    executed_by=CASE WHEN target='EXECUTED' THEN p_payload->>'actor' ELSE executed_by END,
    executed_at=CASE WHEN target='EXECUTED' THEN now_at ELSE executed_at END,
    execution_reference=CASE WHEN target='EXECUTED' THEN p_payload->>'executionReference' ELSE execution_reference END
  WHERE id=d.id RETURNING * INTO d;
  INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
    VALUES(d.id,p_payload->>'idempotencyKey',p_payload->>'actor',prior,target,COALESCE(p_payload->'metadata','{}'::jsonb));
  RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION record_decision_outcome(p_payload JSONB) RETURNS JSONB AS $$
DECLARE d decisions%ROWTYPE; existing_outcome UUID; now_at TIMESTAMPTZ := NOW(); target TEXT := p_payload->>'status'; prior TEXT;
BEGIN
  SELECT * INTO d FROM decisions WHERE id=(p_payload->>'decisionId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DECISION_NOT_FOUND'; END IF;
  SELECT id INTO existing_outcome FROM decision_outcomes WHERE decision_id=d.id AND idempotency_key=p_payload->>'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',true); END IF;
  IF d.decision_mode='SHADOW' THEN
    IF target='INCONCLUSIVE' AND NULLIF(BTRIM(p_payload->>'inconclusiveReason'),'') IS NULL THEN RAISE EXCEPTION 'INCONCLUSIVE_REASON_REQUIRED'; END IF;
    INSERT INTO decision_outcomes(decision_id,idempotency_key,status,observed_outcome,measured_at,evidence_refs,inconclusive_reason,recorded_by)
      VALUES(d.id,p_payload->>'idempotencyKey',target,p_payload->>'observedOutcome',(p_payload->>'measuredAt')::timestamptz,
        COALESCE(p_payload->'evidenceRefs','[]'::jsonb),p_payload->>'inconclusiveReason',p_payload->>'actor');
    UPDATE decisions SET outcome_status=target,outcome_recorded_at=now_at,updated_at=now_at WHERE id=d.id RETURNING * INTO d;
    INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
      VALUES(d.id,p_payload->>'idempotencyKey',p_payload->>'actor',d.decision_status,d.decision_status,'{"event":"SHADOW_OUTCOME_OBSERVED"}');
    RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',false);
  END IF;
  IF d.decision_status='EXECUTED' THEN
    INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
      VALUES(d.id,(p_payload->>'idempotencyKey')||':pending',p_payload->>'actor','EXECUTED','OUTCOME_PENDING','{"event":"OUTCOME_MEASUREMENT_STARTED"}');
    UPDATE decisions SET decision_status='OUTCOME_PENDING',updated_at=now_at WHERE id=d.id RETURNING * INTO d;
  END IF;
  IF d.decision_status <> 'OUTCOME_PENDING' THEN RAISE EXCEPTION 'INVALID_OUTCOME_STATE: %',d.decision_status; END IF;
  IF target='INCONCLUSIVE' AND NULLIF(BTRIM(p_payload->>'inconclusiveReason'),'') IS NULL THEN RAISE EXCEPTION 'INCONCLUSIVE_REASON_REQUIRED'; END IF;
  prior := d.decision_status;
  INSERT INTO decision_outcomes(decision_id,idempotency_key,status,observed_outcome,measured_at,evidence_refs,inconclusive_reason,recorded_by)
    VALUES(d.id,p_payload->>'idempotencyKey',target,p_payload->>'observedOutcome',(p_payload->>'measuredAt')::timestamptz,
      COALESCE(p_payload->'evidenceRefs','[]'::jsonb),p_payload->>'inconclusiveReason',p_payload->>'actor');
  UPDATE decisions SET decision_status=target,outcome_status=target,outcome_recorded_at=now_at,updated_at=now_at WHERE id=d.id RETURNING * INTO d;
  INSERT INTO decision_audit_events(decision_id,idempotency_key,actor,previous_status,new_status,metadata)
    VALUES(d.id,p_payload->>'idempotencyKey',p_payload->>'actor',prior,target,jsonb_build_object('measuredAt',p_payload->>'measuredAt'));
  RETURN jsonb_build_object('decision',to_jsonb(d),'idempotent',false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_decision_core(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION transition_decision_core(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_decision_outcome(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_decision_core(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION transition_decision_core(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION record_decision_outcome(JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION create_decision_core(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION transition_decision_core(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION record_decision_outcome(JSONB) TO service_role;
