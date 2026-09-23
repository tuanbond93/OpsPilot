-- Add a durable run-to-job link without rewriting existing AI jobs.
BEGIN;

ALTER TABLE public.incident_triage_evaluations
  ADD COLUMN ai_job_id uuid;

ALTER TABLE public.incident_triage_evaluations
  ADD CONSTRAINT incident_triage_evaluations_ai_job_id_fkey
  FOREIGN KEY (ai_job_id)
  REFERENCES public.ai_analysis_jobs(id)
  ON DELETE SET NULL
  NOT VALID;

CREATE OR REPLACE FUNCTION public.enqueue_ai_analysis_jobs_for_sync_run(p_sync_run_id uuid)
RETURNS TABLE (
  eligible_count integer,
  already_linked_count integer,
  reused_count integer,
  created_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_eligible_count integer;
  v_already_linked_count integer;
  v_reused_count integer;
  v_created_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_sync_run_id::text, 0)
  );

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE t.ai_job_id IS NOT NULL)::integer
  INTO v_eligible_count, v_already_linked_count
  FROM public.incident_triage_evaluations AS t
  WHERE t.sync_run_id = p_sync_run_id
    AND t.evidence ->> 'aiJobEligible' = 'true';

  WITH eligible AS MATERIALIZED (
    SELECT
      t.id AS triage_id,
      t.incident_id,
      CASE
        WHEN i.priority_score >= 75 THEN 'urgent'
        WHEN i.priority_score >= 50 THEN 'high'
        ELSE 'medium'
      END::varchar(20) AS priority
    FROM public.incident_triage_evaluations AS t
    JOIN public.incidents AS i ON i.id = t.incident_id
    WHERE t.sync_run_id = p_sync_run_id
      AND t.evidence ->> 'aiJobEligible' = 'true'
      AND t.ai_job_id IS NULL
  ),
  active_jobs AS MATERIALIZED (
    SELECT DISTINCT ON (j.incident_id)
      j.incident_id,
      j.id AS job_id
    FROM eligible AS e
    JOIN public.ai_analysis_jobs AS j ON j.incident_id = e.incident_id
    WHERE j.status IN ('PENDING', 'PROCESSING')
    ORDER BY
      j.incident_id,
      (j.status = 'PROCESSING') DESC,
      j.created_at ASC,
      j.id ASC
  ),
  linked_existing AS (
    UPDATE public.incident_triage_evaluations AS t
    SET ai_job_id = a.job_id
    FROM eligible AS e
    JOIN active_jobs AS a ON a.incident_id = e.incident_id
    WHERE t.id = e.triage_id
      AND t.ai_job_id IS NULL
    RETURNING t.id
  ),
  jobs_to_create AS MATERIALIZED (
    SELECT e.*
    FROM eligible AS e
    LEFT JOIN active_jobs AS a ON a.incident_id = e.incident_id
    WHERE a.job_id IS NULL
  ),
  created_jobs AS (
    INSERT INTO public.ai_analysis_jobs (incident_id, priority, status)
    SELECT incident_id, priority, 'PENDING'
    FROM jobs_to_create
    RETURNING id, incident_id
  ),
  linked_created AS (
    UPDATE public.incident_triage_evaluations AS t
    SET ai_job_id = j.id
    FROM created_jobs AS j
    WHERE t.sync_run_id = p_sync_run_id
      AND t.incident_id = j.incident_id
      AND t.ai_job_id IS NULL
    RETURNING t.id
  )
  SELECT
    (SELECT count(*)::integer FROM linked_existing),
    (SELECT count(*)::integer FROM linked_created)
  INTO v_reused_count, v_created_count;

  RETURN QUERY
  SELECT v_eligible_count, v_already_linked_count, v_reused_count, v_created_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_ai_analysis_jobs_for_sync_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_ai_analysis_jobs_for_sync_run(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_analysis_jobs_for_sync_run(uuid) TO service_role;

COMMIT;
