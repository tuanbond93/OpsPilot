-- OpsPilot Lean Reset V1 — OWNER APPROVAL DRAFT ONLY.
-- This file was prepared but NOT RUN. Do not deploy or run before:
--   1) owner approval of the exact row-loss predicates below;
--   2) Outcome Case #2 and the contest evidence pack are ready;
--   3) the current successful/incomplete sync IDs below are revalidated;
--   4) sync writers are stopped; ACCESS EXCLUSIVE NOWAIT must succeed.
-- It never deletes decision, decision_evidence_snapshots, decision_audit_events,
-- or decision_outcomes. It does not touch immutable conversation/Telegram event
-- tables, and intentionally does not VACUUM FULL.
--
-- This is a single transaction. Before COMMIT, ROLLBACK restores staged tables.
-- Exact candidate/retained row counts and proportional size estimates are
-- printed before any TRUNCATE. Review those results before changing both gates
-- to TRUE and executing the whole script.

BEGIN;

DO $approval_gate$
DECLARE
  owner_approved BOOLEAN := FALSE;
  evidence_pack_ready BOOLEAN := FALSE;
BEGIN
  IF NOT owner_approved THEN
    RAISE EXCEPTION 'Owner approval is required before cleanup';
  END IF;
  IF NOT evidence_pack_ready THEN
    RAISE EXCEPTION 'Contest evidence pack is not ready; do not clean up';
  END IF;
END
$approval_gate$;

-- Fail fast rather than wait behind a sync or hold locks while it writes.
LOCK TABLE public.sync_runs,
           public.order_snapshots,
           public.inbound_order_observations,
           public.inbound_population_manifests,
           public.incident_history,
           public.incident_triage_evaluations,
           public.followup_events,
           public.notification_action_events,
           public.planner_review_events,
           public.ai_analysis_jobs
  IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $run_guard$
BEGIN
  IF (SELECT id FROM public.sync_runs WHERE lower(status) = 'success' ORDER BY started_at DESC LIMIT 1)
       IS DISTINCT FROM '93b93af7-11e9-45dd-ab4f-169e99d729d6'::uuid THEN
    RAISE EXCEPTION 'Latest successful sync changed; refresh the keep-set and preflight';
  END IF;
  IF (SELECT id FROM public.sync_runs WHERE lower(status) <> 'success' ORDER BY started_at DESC LIMIT 1)
       IS DISTINCT FROM '1edc2ae6-04c5-47fd-b247-a8042ff518e9'::uuid THEN
    RAISE EXCEPTION 'Latest incomplete sync changed; refresh the keep-set and preflight';
  END IF;
END
$run_guard$;

CREATE TEMP TABLE ops_keep_order_snapshots ON COMMIT DROP AS
SELECT *
FROM public.order_snapshots
WHERE created_at >= now() - interval '48 hours'
   OR sync_run_id IN (
     '93b93af7-11e9-45dd-ab4f-169e99d729d6'::uuid,
     '1edc2ae6-04c5-47fd-b247-a8042ff518e9'::uuid
   );

CREATE TEMP TABLE ops_keep_inbound_observations ON COMMIT DROP AS
SELECT *
FROM public.inbound_order_observations
WHERE sync_run_id IN (
  '93b93af7-11e9-45dd-ab4f-169e99d729d6'::uuid,
  '1edc2ae6-04c5-47fd-b247-a8042ff518e9'::uuid
);

CREATE TEMP TABLE ops_keep_incident_history ON COMMIT DROP AS
WITH ranked AS (
  SELECT h.*,
         row_number() OVER (PARTITION BY h.incident_id ORDER BY h.recorded_at DESC, h.id DESC) AS keep_rank
  FROM public.incident_history h
)
SELECT h.id, h.incident_id, h.sync_run_id, h.recorded_at,
       h.affected_order_count, h.average_age_hours, h.maximum_age_hours,
       h.oldest_order_code, h.priority_score, h.sample_order_codes, h.created_at
FROM ranked h
WHERE (h.keep_rank <= 2 AND EXISTS (
         SELECT 1 FROM public.incidents i
         WHERE i.id = h.incident_id AND i.status IN ('open', 'monitoring')
       ))
   OR EXISTS (SELECT 1 FROM public.decisions d WHERE d.incident_id = h.incident_id)
   OR EXISTS (SELECT 1 FROM public.incident_verifications v WHERE v.incident_id = h.incident_id)
   OR EXISTS (SELECT 1 FROM public.incident_feedback_reports f WHERE f.incident_id = h.incident_id);

CREATE TEMP TABLE ops_keep_followup_events ON COMMIT DROP AS
SELECT e.*
FROM public.followup_events e
WHERE e.event_time >= now() - interval '3 days'
   OR EXISTS (
     SELECT 1 FROM public.followup_cases c
     WHERE c.id = e.followup_case_id
       AND c.current_state::text NOT IN ('RESOLVED', 'CLOSED')
   );

CREATE TEMP TABLE ops_keep_notification_action_events ON COMMIT DROP AS
WITH ranked AS (
  SELECT e.*,
         row_number() OVER (PARTITION BY e.action_id ORDER BY e.created_at DESC, e.id DESC) AS keep_rank
  FROM public.notification_action_events e
)
SELECT e.id, e.action_id, e.event_type, e.old_status, e.new_status,
       e.attempt_number, e.provider, e.provider_message_id, e.error_code,
       e.error_message, e.metadata, e.created_at
FROM ranked e
WHERE e.created_at >= now() - interval '1 day'
   OR e.keep_rank <= 50
   OR EXISTS (
     SELECT 1 FROM public.notification_actions a
     WHERE a.id = e.action_id AND a.status IN ('PENDING', 'PROCESSING')
   )
   OR EXISTS (
     SELECT 1
     FROM public.notification_actions a
     JOIN public.decisions d
       ON d.id::text = a.target_id::text OR d.incident_id::text = a.target_id::text
     WHERE a.id = e.action_id
   );

CREATE TEMP TABLE ops_keep_planner_review_events ON COMMIT DROP AS
WITH ranked AS (
  SELECT e.*,
         row_number() OVER (PARTITION BY e.planner_run_id ORDER BY e.created_at DESC, e.id DESC) AS keep_rank
  FROM public.planner_review_events e
)
SELECT e.id, e.planner_run_id, e.event_type, e.actor, e.note, e.created_at
FROM ranked e
WHERE e.created_at >= now() - interval '3 days'
   OR e.keep_rank <= 5
   OR EXISTS (
     SELECT 1 FROM public.planner_runs p
     JOIN public.decisions d ON d.incident_id = p.incident_id
     WHERE p.id = e.planner_run_id
   );

CREATE TEMP TABLE ops_keep_ai_analysis_jobs ON COMMIT DROP AS
SELECT j.*
FROM public.ai_analysis_jobs j
WHERE j.status IN ('PENDING', 'PROCESSING')
   OR j.updated_at >= now() - interval '7 days'
   OR EXISTS (SELECT 1 FROM public.decisions d WHERE d.incident_id = j.incident_id);

-- Exact locked row counts. Proportional MB estimates are approximate because
-- index sizes and row widths differ; table size is re-read at approval time.
SELECT 'order_snapshots' AS table_name,
       (SELECT count(*) FROM public.order_snapshots) AS current_rows,
       (SELECT count(*) FROM ops_keep_order_snapshots) AS retained_rows,
       (SELECT count(*) FROM public.order_snapshots) - (SELECT count(*) FROM ops_keep_order_snapshots) AS rows_expected_removed,
       round(pg_total_relation_size('public.order_snapshots')::numeric / 1048576, 2) AS current_mb,
       round(pg_total_relation_size('public.order_snapshots')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_order_snapshots)::numeric / NULLIF((SELECT count(*) FROM public.order_snapshots), 0)), 2) AS estimated_reclaim_mb
UNION ALL
SELECT 'inbound_order_observations',
       (SELECT count(*) FROM public.inbound_order_observations),
       (SELECT count(*) FROM ops_keep_inbound_observations),
       (SELECT count(*) FROM public.inbound_order_observations) - (SELECT count(*) FROM ops_keep_inbound_observations),
       round(pg_total_relation_size('public.inbound_order_observations')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.inbound_order_observations')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_inbound_observations)::numeric / NULLIF((SELECT count(*) FROM public.inbound_order_observations), 0)), 2)
UNION ALL
SELECT 'incident_history',
       (SELECT count(*) FROM public.incident_history),
       (SELECT count(*) FROM ops_keep_incident_history),
       (SELECT count(*) FROM public.incident_history) - (SELECT count(*) FROM ops_keep_incident_history),
       round(pg_total_relation_size('public.incident_history')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.incident_history')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_incident_history)::numeric / NULLIF((SELECT count(*) FROM public.incident_history), 0)), 2)
UNION ALL
SELECT 'followup_events',
       (SELECT count(*) FROM public.followup_events),
       (SELECT count(*) FROM ops_keep_followup_events),
       (SELECT count(*) FROM public.followup_events) - (SELECT count(*) FROM ops_keep_followup_events),
       round(pg_total_relation_size('public.followup_events')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.followup_events')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_followup_events)::numeric / NULLIF((SELECT count(*) FROM public.followup_events), 0)), 2)
UNION ALL
SELECT 'notification_action_events',
       (SELECT count(*) FROM public.notification_action_events),
       (SELECT count(*) FROM ops_keep_notification_action_events),
       (SELECT count(*) FROM public.notification_action_events) - (SELECT count(*) FROM ops_keep_notification_action_events),
       round(pg_total_relation_size('public.notification_action_events')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.notification_action_events')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_notification_action_events)::numeric / NULLIF((SELECT count(*) FROM public.notification_action_events), 0)), 2)
UNION ALL
SELECT 'planner_review_events',
       (SELECT count(*) FROM public.planner_review_events),
       (SELECT count(*) FROM ops_keep_planner_review_events),
       (SELECT count(*) FROM public.planner_review_events) - (SELECT count(*) FROM ops_keep_planner_review_events),
       round(pg_total_relation_size('public.planner_review_events')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.planner_review_events')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_planner_review_events)::numeric / NULLIF((SELECT count(*) FROM public.planner_review_events), 0)), 2)
UNION ALL
SELECT 'ai_analysis_jobs',
       (SELECT count(*) FROM public.ai_analysis_jobs),
       (SELECT count(*) FROM ops_keep_ai_analysis_jobs),
       (SELECT count(*) FROM public.ai_analysis_jobs) - (SELECT count(*) FROM ops_keep_ai_analysis_jobs),
       round(pg_total_relation_size('public.ai_analysis_jobs')::numeric / 1048576, 2),
       round(pg_total_relation_size('public.ai_analysis_jobs')::numeric / 1048576 *
         (1 - (SELECT count(*) FROM ops_keep_ai_analysis_jobs)::numeric / NULLIF((SELECT count(*) FROM public.ai_analysis_jobs), 0)), 2);

-- `incident_triage_evaluations` is not truncated: decision_telegram_shadows
-- holds ON DELETE RESTRICT references. If the owner separately approves its
-- logical old-row purge, retain the latest current evaluation and every FK row:
WITH ranked AS (
  SELECT e.id, e.incident_id,
         row_number() OVER (PARTITION BY e.incident_id ORDER BY e.created_at DESC, e.id DESC) AS keep_rank
  FROM public.incident_triage_evaluations e
)
SELECT count(*) AS triage_rows_expected_removed
FROM ranked r
WHERE NOT (r.keep_rank = 1 AND EXISTS (
        SELECT 1 FROM public.incidents i WHERE i.id = r.incident_id AND i.status IN ('open', 'monitoring')
      ))
  AND NOT EXISTS (SELECT 1 FROM public.decisions d WHERE d.incident_id = r.incident_id)
  AND NOT EXISTS (SELECT 1 FROM public.decision_telegram_shadows s WHERE s.triage_audit_id = r.id);
--
-- WITH ranked AS (
--   SELECT e.id, e.incident_id,
--          row_number() OVER (PARTITION BY e.incident_id ORDER BY e.created_at DESC, e.id DESC) AS keep_rank
--   FROM public.incident_triage_evaluations e
-- )
-- DELETE FROM public.incident_triage_evaluations e
-- USING ranked r
-- WHERE e.id = r.id
--   AND NOT (r.keep_rank = 1 AND EXISTS (
--     SELECT 1 FROM public.incidents i WHERE i.id = e.incident_id AND i.status IN ('open', 'monitoring')
--   ))
--   AND NOT EXISTS (SELECT 1 FROM public.decisions d WHERE d.incident_id = e.incident_id)
--   AND NOT EXISTS (SELECT 1 FROM public.decision_telegram_shadows s WHERE s.triage_audit_id = e.id);

-- Physical rebuild only after the owner has reviewed every preflight count.
TRUNCATE TABLE public.order_snapshots,
             public.inbound_order_observations,
             public.incident_history,
             public.followup_events,
             public.notification_action_events,
             public.planner_review_events,
             public.ai_analysis_jobs
  RESTART IDENTITY;

INSERT INTO public.order_snapshots OVERRIDING SYSTEM VALUE
SELECT * FROM ops_keep_order_snapshots;
INSERT INTO public.inbound_order_observations OVERRIDING SYSTEM VALUE
SELECT * FROM ops_keep_inbound_observations;
INSERT INTO public.incident_history OVERRIDING SYSTEM VALUE
SELECT * FROM ops_keep_incident_history;
INSERT INTO public.followup_events
SELECT * FROM ops_keep_followup_events;
INSERT INTO public.notification_action_events
SELECT * FROM ops_keep_notification_action_events;
INSERT INTO public.planner_review_events
SELECT * FROM ops_keep_planner_review_events;
INSERT INTO public.ai_analysis_jobs
SELECT * FROM ops_keep_ai_analysis_jobs;

SELECT setval(pg_get_serial_sequence('public.order_snapshots', 'id'),
              COALESCE((SELECT max(id) FROM public.order_snapshots), 1),
              EXISTS (SELECT 1 FROM public.order_snapshots));
SELECT setval(pg_get_serial_sequence('public.inbound_order_observations', 'id'),
              COALESCE((SELECT max(id) FROM public.inbound_order_observations), 1),
              EXISTS (SELECT 1 FROM public.inbound_order_observations));
SELECT setval(pg_get_serial_sequence('public.incident_history', 'id'),
              COALESCE((SELECT max(id) FROM public.incident_history), 1),
              EXISTS (SELECT 1 FROM public.incident_history));

-- Intentionally retain all inbound_population_manifests and sync_runs as tiny
-- authority/recovery records. Immutable conversation and Telegram events are
-- not touched. The evidence gate must be explicitly satisfied before this
-- transaction can be approved.

-- OWNER: inspect the preflight output, then COMMIT only if counts and keep-sets
-- match the approved evidence package. Otherwise issue ROLLBACK.
COMMIT;
