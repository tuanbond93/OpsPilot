-- Atomically queue one existing stale, resumable checkpoint run for the
-- existing authenticated recovery dispatcher. This function never generates
-- a recovery token, calls the dispatcher, or changes the sync run/population.
BEGIN;

CREATE OR REPLACE FUNCTION public.queue_stale_checkpoint_recovery_for_run(p_sync_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run public.sync_runs%ROWTYPE;
  v_recovery public.checkpoint_recoveries%ROWTYPE;
  v_manifest public.inbound_population_manifests%ROWTYPE;
  v_run_count integer;
  v_observation_count bigint;
  v_distinct_order_count bigint;
  v_now timestamptz;
  v_inserted_checkpoint timestamptz;
BEGIN
  IF p_sync_run_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'SYNC_RUN_ID_REQUIRED',
      'syncRunId', NULL, 'checkpointAt', NULL, 'recoveryStatus', NULL,
      'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  -- The relation lock closes the absent-row race with acquire_sync_lock(),
  -- while remaining scoped to the short validation-and-insert transaction.
  LOCK TABLE public.sync_locks IN SHARE ROW EXCLUSIVE MODE;
  v_now := pg_catalog.clock_timestamp();

  SELECT * INTO v_run
  FROM public.sync_runs
  WHERE id = p_sync_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'RUN_NOT_FOUND',
      'syncRunId', p_sync_run_id, 'checkpointAt', NULL, 'recoveryStatus', NULL,
      'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  IF v_run.checkpoint_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'CHECKPOINT_NOT_SET',
      'syncRunId', p_sync_run_id, 'checkpointAt', NULL, 'recoveryStatus', NULL,
      'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_run_count
  FROM public.sync_runs
  WHERE checkpoint_at = v_run.checkpoint_at;
  IF v_run_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'CHECKPOINT_RUN_NOT_UNIQUE',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', NULL, 'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  -- A repeated request for this same run is a read-only success, including
  -- after the dispatcher has advanced the existing recovery state.
  SELECT * INTO v_recovery
  FROM public.checkpoint_recoveries
  WHERE checkpoint_at = v_run.checkpoint_at;
  IF FOUND THEN
    IF v_recovery.sync_run_id = p_sync_run_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'ALREADY_QUEUED', 'code', NULL,
        'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
        'recoveryStatus', v_recovery.status, 'recoveryAttempt', v_recovery.recovery_attempt,
        'tokenPresent', v_recovery.recovery_token IS NOT NULL
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'CHECKPOINT_RECOVERY_EXISTS',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', v_recovery.status, 'recoveryAttempt', v_recovery.recovery_attempt,
      'tokenPresent', v_recovery.recovery_token IS NOT NULL
    );
  END IF;

  IF v_run.status IS DISTINCT FROM 'running'
    OR v_run.completed_at IS NOT NULL
    OR v_run.current_phase IS DISTINCT FROM 'ENQUEUE_NOTIFICATIONS'
    OR coalesce(v_run.completed_phases, '[]'::jsonb) @> '["ENQUEUE_AI"]'::jsonb
    OR NOT (coalesce(v_run.completed_phases, '[]'::jsonb) @> '["CREATED","FETCHING_SNAPSHOT","PERSISTING_SNAPSHOTS","PERSISTING_INCIDENTS","PERSISTING_HISTORY","PROCESSING_FOLLOWUPS","ENQUEUE_NOTIFICATIONS"]'::jsonb)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'RUN_NOT_RESUMABLE',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', NULL, 'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  SELECT * INTO v_manifest
  FROM public.inbound_population_manifests
  WHERE sync_run_id = p_sync_run_id
    AND source_system = 'RILLNET';
  IF NOT FOUND OR v_manifest.population_status IS DISTINCT FROM 'COMPLETE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'RILLNET_POPULATION_NOT_COMPLETE',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', NULL, 'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT order_code)
  INTO v_observation_count, v_distinct_order_count
  FROM public.inbound_order_observations
  WHERE sync_run_id = p_sync_run_id
    AND source_system = 'RILLNET';
  IF v_manifest.expected_observation_count <> v_manifest.persisted_observation_count
    OR v_manifest.duplicate_conflict_count <> 0
    OR v_observation_count <> v_manifest.expected_observation_count
    OR v_distinct_order_count <> v_manifest.expected_observation_count
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'RILLNET_POPULATION_COUNT_MISMATCH',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', NULL, 'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sync_locks
    WHERE lock_key = 'global:rillnet-sync'
      AND expires_at > v_now
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'REJECTED', 'code', 'SYNC_LEASE_ACTIVE',
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', NULL, 'recoveryAttempt', NULL, 'tokenPresent', false
    );
  END IF;

  INSERT INTO public.checkpoint_recoveries (
    checkpoint_at,
    recovery_attempt,
    status,
    scheduled_for,
    next_attempt_at,
    recovery_token,
    sync_run_id,
    failure_stage,
    last_safe_error
  ) VALUES (
    v_run.checkpoint_at,
    0,
    'PENDING',
    v_now,
    v_now,
    NULL,
    p_sync_run_id,
    'OPERATOR_STALE_RUN_RECOVERY',
    'Stale checkpoint recovery queued by an authorized operator'
  )
  ON CONFLICT (checkpoint_at) DO NOTHING
  RETURNING checkpoint_at INTO v_inserted_checkpoint;

  IF v_inserted_checkpoint IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'QUEUED', 'code', NULL,
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', 'PENDING', 'recoveryAttempt', 0, 'tokenPresent', false
    );
  END IF;

  -- A concurrent operator request won the checkpoint primary key. Read it
  -- without changing it, then return idempotent success or a safe conflict.
  SELECT * INTO v_recovery
  FROM public.checkpoint_recoveries
  WHERE checkpoint_at = v_run.checkpoint_at;
  IF FOUND AND v_recovery.sync_run_id = p_sync_run_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'ALREADY_QUEUED', 'code', NULL,
      'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
      'recoveryStatus', v_recovery.status, 'recoveryAttempt', v_recovery.recovery_attempt,
      'tokenPresent', v_recovery.recovery_token IS NOT NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'REJECTED', 'code', 'CHECKPOINT_RECOVERY_EXISTS',
    'syncRunId', p_sync_run_id, 'checkpointAt', v_run.checkpoint_at,
    'recoveryStatus', CASE WHEN FOUND THEN v_recovery.status ELSE NULL END,
    'recoveryAttempt', CASE WHEN FOUND THEN v_recovery.recovery_attempt ELSE NULL END,
    'tokenPresent', CASE WHEN FOUND THEN v_recovery.recovery_token IS NOT NULL ELSE false END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_stale_checkpoint_recovery_for_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_stale_checkpoint_recovery_for_run(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_stale_checkpoint_recovery_for_run(uuid) TO service_role;

COMMIT;
