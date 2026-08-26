-- OpsPilot Migration 025: repair the deployed outcome-verifier RPC timestamp cast.
-- Migration 023 passed JSON text directly into a TIMESTAMPTZ column. PostgreSQL
-- does not implicitly cast that expression inside INSERT, so verification failed
-- atomically before any outcome, audit event, or status transition was persisted.

CREATE OR REPLACE FUNCTION record_verified_decision_outcome(p_payload JSONB) RETURNS JSONB AS $$
DECLARE
  d decisions%ROWTYPE;
  c decision_outcome_observation_contracts%ROWTYPE;
  prior UUID;
  outcome_result JSONB;
  observed_at_value TIMESTAMPTZ := (p_payload->>'observedAt')::timestamptz;
BEGIN
  SELECT * INTO d FROM decisions WHERE id=(p_payload->>'decisionId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DECISION_NOT_FOUND'; END IF;
  SELECT * INTO c FROM decision_outcome_observation_contracts WHERE decision_id=d.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTCOME_OBSERVATION_CONTRACT_REQUIRED'; END IF;
  SELECT id INTO prior FROM decision_outcome_verifications WHERE decision_id=d.id AND idempotency_key=p_payload->>'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('decision', to_jsonb(d), 'idempotent', true); END IF;
  IF observed_at_value < c.measurement_window_end THEN RAISE EXCEPTION 'OUTCOME_MEASUREMENT_WINDOW_NOT_REACHED'; END IF;
  IF jsonb_typeof(p_payload->'evidenceRefs') <> 'array' OR jsonb_array_length(p_payload->'evidenceRefs') = 0 THEN RAISE EXCEPTION 'OUTCOME_EVIDENCE_REQUIRED'; END IF;
  outcome_result := record_decision_outcome(jsonb_build_object(
    'decisionId',p_payload->>'decisionId','status',p_payload#>>'{verification,classification}',
    'observedOutcome',p_payload->>'observedOutcome','measuredAt',p_payload->>'observedAt',
    'evidenceRefs',p_payload->'evidenceRefs','inconclusiveReason',p_payload->>'inconclusiveReason',
    'actor',p_payload->>'actor','idempotencyKey',p_payload->>'idempotencyKey'
  ));
  INSERT INTO decision_outcome_verifications(decision_id,contract_id,idempotency_key,classification,reason_code,
    baseline_affected_orders,observed_affected_orders,observed_metrics,observed_at,source,evidence_refs,verified_by)
  VALUES(d.id,c.id,p_payload->>'idempotencyKey',p_payload#>>'{verification,classification}',p_payload#>>'{verification,reasonCode}',
    NULLIF(p_payload#>>'{verification,baselineAffectedOrders}','')::integer,NULLIF(p_payload#>>'{verification,observedAffectedOrders}','')::integer,
    p_payload->'observedMetrics',observed_at_value,p_payload->>'source',p_payload->'evidenceRefs',p_payload->>'actor');
  RETURN outcome_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION record_verified_decision_outcome(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_verified_decision_outcome(JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION record_verified_decision_outcome(JSONB) TO service_role;
