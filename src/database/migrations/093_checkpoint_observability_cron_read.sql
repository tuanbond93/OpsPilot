-- Read-only, fixed-scope access to pg_cron evidence for the OpsPilot checkpoint.
-- This exposes no scheduler mutation capability and never returns the SQL command.
CREATE OR REPLACE FUNCTION public.opspilot_checkpoint_cron_evidence(
  p_checkpoint_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH target_job AS (
    SELECT job.jobid, job.jobname, job.schedule, job.active
    FROM cron.job AS job
    WHERE job.jobname = 'opspilot-followup-cycle-mb3'
  ),
  target_runs AS (
    SELECT
      details.jobid,
      details.runid,
      details.start_time,
      details.end_time,
      details.status,
      details.return_message
    FROM cron.job_run_details AS details
    INNER JOIN target_job AS job ON job.jobid = details.jobid
    WHERE p_checkpoint_at IS NOT NULL
      AND details.start_time >= p_checkpoint_at - INTERVAL '5 minutes'
      AND details.start_time < p_checkpoint_at + INTERVAL '2 hours'
  )
  SELECT pg_catalog.jsonb_build_object(
    'job_found',
    EXISTS (SELECT 1 FROM target_job),
    'job',
    (
      SELECT pg_catalog.jsonb_build_object(
        'job_id', job.jobid,
        'job_name', job.jobname,
        'schedule', job.schedule,
        'active', job.active
      )
      FROM target_job AS job
      LIMIT 1
    ),
    'runs',
    COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'job_id', run.jobid,
            'run_id', run.runid,
            'start_time', run.start_time,
            'end_time', run.end_time,
            'status', run.status,
            'return_message', run.return_message
          )
          ORDER BY run.start_time
        )
        FROM target_runs AS run
      ),
      '[]'::JSONB
    )
  );
$function$;

REVOKE ALL ON FUNCTION public.opspilot_checkpoint_cron_evidence(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opspilot_checkpoint_cron_evidence(TIMESTAMPTZ)
  TO service_role;

COMMENT ON FUNCTION public.opspilot_checkpoint_cron_evidence(TIMESTAMPTZ) IS
  'Returns fixed-scope, read-only pg_cron job metadata and executions around one OpsPilot checkpoint; available only to the server service role.';
