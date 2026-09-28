-- Migration 103: Durable V1 Worker Batch Persistence, Dead-Letter Safety & Route Claimability
-- Replaces per-case individual updates with bounded set-based RPC.
-- Enforces atomic transition of expired leased units with exhausted attempts to FAILED.
-- Eliminates claimability drift between worker route and claim RPC.

BEGIN;

-- 1. Batch update for parent followup_cases with optimistic concurrency control
CREATE OR REPLACE FUNCTION public.batch_update_followup_cases_cohort(
  p_updates JSONB
)
RETURNS TABLE (
  id UUID,
  incident_id UUID,
  incident_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_expected_count INT;
  v_updated_count INT;
BEGIN
  v_expected_count := jsonb_array_length(p_updates);
  IF v_expected_count = 0 THEN
    RETURN;
  END IF;

  CREATE TEMPORARY TABLE _tmp_updated_cases (
    id UUID,
    incident_id UUID,
    incident_key TEXT,
    member_generation_id UUID
  ) ON COMMIT DROP;

  WITH inputs AS (
    SELECT
      (elem->>'id')::UUID AS c_id,
      (elem->>'expected_updated_at')::TIMESTAMPTZ AS c_expected_updated_at,
      (elem->>'current_state')::public.followup_state_enum AS c_current_state,
      elem->'operational_cohort' AS c_operational_cohort,
      (elem->>'cohort_version')::SMALLINT AS c_cohort_version,
      (elem->>'member_generation_id')::UUID AS c_member_generation_id,
      (elem->>'last_checked_at')::TIMESTAMPTZ AS c_last_checked_at,
      (elem->>'next_action_at')::TIMESTAMPTZ AS c_next_action_at,
      (elem->>'last_action_requested_at')::TIMESTAMPTZ AS c_last_action_requested_at,
      (elem->>'last_action_confirmed_at')::TIMESTAMPTZ AS c_last_action_confirmed_at,
      (elem->>'resolved_at')::TIMESTAMPTZ AS c_resolved_at,
      (elem->>'closed_at')::TIMESTAMPTZ AS c_closed_at,
      (elem->>'baseline_affected_order_count')::INT AS c_baseline_affected_order_count,
      (elem->>'latest_affected_order_count')::INT AS c_latest_affected_order_count,
      (elem->>'current_progress_percent')::NUMERIC AS c_current_progress_percent,
      (elem->>'current_assessment')::public.progress_assessment_enum AS c_current_assessment,
      elem->>'current_rillnet_status_signature' AS c_current_rillnet_status_signature,
      elem->>'rillnet_change_summary' AS c_rillnet_change_summary,
      (elem->>'rillnet_changed_at')::TIMESTAMPTZ AS c_rillnet_changed_at
    FROM jsonb_array_elements(p_updates) AS elem
  ),
  updated AS (
    UPDATE public.followup_cases c
    SET
      current_state = coalesce(i.c_current_state, c.current_state),
      operational_cohort = coalesce(i.c_operational_cohort, c.operational_cohort),
      cohort_version = coalesce(i.c_cohort_version, c.cohort_version),
      member_generation_id = coalesce(i.c_member_generation_id, c.member_generation_id),
      updated_at = v_now,
      last_checked_at = coalesce(i.c_last_checked_at, c.last_checked_at),
      next_action_at = CASE WHEN i.c_next_action_at IS NOT NULL THEN i.c_next_action_at ELSE c.next_action_at END,
      last_action_requested_at = CASE WHEN i.c_last_action_requested_at IS NOT NULL THEN i.c_last_action_requested_at ELSE c.last_action_requested_at END,
      last_action_confirmed_at = CASE WHEN i.c_last_action_confirmed_at IS NOT NULL THEN i.c_last_action_confirmed_at ELSE c.last_action_confirmed_at END,
      resolved_at = CASE WHEN i.c_resolved_at IS NOT NULL THEN i.c_resolved_at ELSE c.resolved_at END,
      closed_at = CASE WHEN i.c_closed_at IS NOT NULL THEN i.c_closed_at ELSE c.closed_at END,
      baseline_affected_order_count = coalesce(i.c_baseline_affected_order_count, c.baseline_affected_order_count),
      latest_affected_order_count = coalesce(i.c_latest_affected_order_count, c.latest_affected_order_count),
      current_progress_percent = coalesce(i.c_current_progress_percent, c.current_progress_percent),
      current_assessment = coalesce(i.c_current_assessment, c.current_assessment),
      current_rillnet_status_signature = coalesce(i.c_current_rillnet_status_signature, c.current_rillnet_status_signature),
      rillnet_change_summary = coalesce(i.c_rillnet_change_summary, c.rillnet_change_summary),
      rillnet_changed_at = CASE WHEN i.c_rillnet_changed_at IS NOT NULL THEN i.c_rillnet_changed_at ELSE c.rillnet_changed_at END
    FROM inputs i
    WHERE c.id = i.c_id
      AND (
        c.updated_at = i.c_expected_updated_at
        OR (c.cohort_version = 2 AND c.member_generation_id = i.c_member_generation_id)
      )
    RETURNING c.id, c.incident_id, c.incident_key, c.member_generation_id
  )
  INSERT INTO _tmp_updated_cases (id, incident_id, incident_key, member_generation_id)
  SELECT updated.id, updated.incident_id, updated.incident_key, updated.member_generation_id FROM updated;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> v_expected_count THEN
    RAISE EXCEPTION 'FOLLOWUP_COHORT_BATCH_CONCURRENT_MODIFICATION:expected=%:actual=%', v_expected_count, v_updated_count;
  END IF;

  UPDATE public.followup_case_member_generations g
  SET generation_status = 'COMMITTED', committed_at = v_now
  FROM _tmp_updated_cases u
  WHERE g.followup_case_id = u.id
    AND g.generation_id = u.member_generation_id;

  RETURN QUERY
  SELECT u.id, u.incident_id, u.incident_key FROM _tmp_updated_cases u;
END;
$function$;

REVOKE ALL ON FUNCTION public.batch_update_followup_cases_cohort(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_update_followup_cases_cohort(JSONB) TO service_role;

-- 2. Scoped V1 claim function with atomic dead-letter transition for exhausted units
CREATE OR REPLACE FUNCTION public.claim_checkpoint_work_units(
  p_checkpoint_at TIMESTAMPTZ,
  p_worker_id TEXT,
  p_lease_seconds INT,
  p_limit INT,
  p_execution_mode TEXT,
  p_pipeline_version TEXT
)
RETURNS SETOF public.checkpoint_work_units
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_lease_expiry TIMESTAMPTZ := v_now + make_interval(secs => p_lease_seconds);
BEGIN
  IF p_pipeline_version NOT IN ('V1', 'V2') THEN
    RAISE EXCEPTION 'INVALID_PIPELINE_VERSION';
  END IF;

  -- Phase 3: Transition expired leased units with exhausted attempts to FAILED
  UPDATE public.checkpoint_work_units
  SET status = 'FAILED',
      lease_owner = NULL,
      lease_expires_at = NULL,
      failure_code = coalesce(failure_code, 'V1_WORK_UNIT_ATTEMPTS_EXHAUSTED'),
      last_safe_error = coalesce(last_safe_error, 'V1_WORK_UNIT_ATTEMPTS_EXHAUSTED'),
      updated_at = v_now
  WHERE checkpoint_at = p_checkpoint_at
    AND execution_mode = p_execution_mode
    AND cursor #>> '{metadata,pipelineVersion}' = p_pipeline_version
    AND status = 'LEASED'
    AND lease_expires_at <= v_now
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.checkpoint_work_units
    WHERE checkpoint_at = p_checkpoint_at
      AND execution_mode = p_execution_mode
      AND cursor #>> '{metadata,pipelineVersion}' = p_pipeline_version
      AND (
        (status = 'PENDING' AND (retry_after IS NULL OR retry_after <= v_now))
        OR (status = 'LEASED' AND lease_expires_at <= v_now)
      )
      AND attempts < max_attempts
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.checkpoint_work_units w
  SET status = 'LEASED', lease_owner = p_worker_id,
      lease_expires_at = v_lease_expiry,
      started_at = coalesce(w.started_at, v_now),
      attempts = w.attempts + 1, updated_at = v_now
  FROM claimable
  WHERE w.id = claimable.id
  RETURNING w.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkpoint_work_units(TIMESTAMPTZ, TEXT, INT, INT, TEXT, TEXT) TO service_role;

-- 3. Authoritative primitive to find next actionable V1 checkpoint (eliminates route/RPC drift)
CREATE OR REPLACE FUNCTION public.get_next_actionable_v1_checkpoint(
  p_execution_mode TEXT DEFAULT 'PRODUCTION'
)
RETURNS TABLE (
  checkpoint_at TIMESTAMPTZ,
  sync_run_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- Sweep expired LEASED units with exhausted attempts to FAILED across all V1 checkpoints
  UPDATE public.checkpoint_work_units
  SET status = 'FAILED',
      lease_owner = NULL,
      lease_expires_at = NULL,
      failure_code = coalesce(failure_code, 'V1_WORK_UNIT_ATTEMPTS_EXHAUSTED'),
      last_safe_error = coalesce(last_safe_error, 'V1_WORK_UNIT_ATTEMPTS_EXHAUSTED'),
      updated_at = v_now
  WHERE execution_mode = p_execution_mode
    AND cursor #>> '{metadata,pipelineVersion}' = 'V1'
    AND status = 'LEASED'
    AND lease_expires_at <= v_now
    AND attempts >= max_attempts;

  -- Return earliest checkpoint having claimable work OR an unfinalized sync run
  RETURN QUERY
  SELECT DISTINCT ON (w.checkpoint_at) w.checkpoint_at, w.sync_run_id
  FROM public.checkpoint_work_units w
  JOIN public.sync_runs s ON s.id = w.sync_run_id
  WHERE w.execution_mode = p_execution_mode
    AND w.cursor #>> '{metadata,pipelineVersion}' = 'V1'
    AND s.status = 'running'
    AND (
      -- Has claimable units
      (w.status = 'PENDING' AND (w.retry_after IS NULL OR w.retry_after <= v_now) AND w.attempts < w.max_attempts)
      OR (w.status = 'LEASED' AND (w.lease_expires_at > v_now OR w.attempts < w.max_attempts))
      -- Or all units resolved (COMPLETED or FAILED) so finalizer can run
      OR NOT EXISTS (
        SELECT 1 FROM public.checkpoint_work_units sub
        WHERE sub.sync_run_id = w.sync_run_id
          AND sub.status IN ('PENDING', 'LEASED')
      )
    )
  ORDER BY w.checkpoint_at ASC
  LIMIT 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_next_actionable_v1_checkpoint(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_actionable_v1_checkpoint(TEXT) TO service_role;

COMMIT;
