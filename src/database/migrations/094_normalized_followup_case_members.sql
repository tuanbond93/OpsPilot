BEGIN;

ALTER TABLE public.followup_cases
  ADD COLUMN IF NOT EXISTS cohort_version smallint,
  ADD COLUMN IF NOT EXISTS member_generation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'followup_cases_cohort_generation_consistency'
      AND conrelid = 'public.followup_cases'::regclass
  ) THEN
    ALTER TABLE public.followup_cases
      ADD CONSTRAINT followup_cases_cohort_generation_consistency
      CHECK (
        (cohort_version IS NULL AND member_generation_id IS NULL)
        OR (cohort_version = 1 AND member_generation_id IS NULL)
        OR (cohort_version = 2 AND member_generation_id IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

-- Durable per-case generation state lets the operator cleanup retain the
-- current and immediately previous committed generations without promotion.
CREATE TABLE IF NOT EXISTS public.followup_case_member_generations (
  followup_case_id uuid NOT NULL
    REFERENCES public.followup_cases(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  source_sync_run_id uuid NULL
    REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  expected_member_count integer NOT NULL CHECK (expected_member_count >= 0),
  generation_status text NOT NULL DEFAULT 'PREPARING'
    CHECK (generation_status IN ('PREPARING', 'COMMITTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz NULL,
  CONSTRAINT followup_case_member_generations_pkey
    PRIMARY KEY (followup_case_id, generation_id),
  CONSTRAINT followup_case_member_generations_commit_timestamp
    CHECK ((generation_status = 'PREPARING' AND committed_at IS NULL)
      OR (generation_status = 'COMMITTED' AND committed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_followup_case_member_generations_retention
  ON public.followup_case_member_generations(followup_case_id, committed_at DESC, created_at DESC, generation_id DESC)
  WHERE generation_status = 'COMMITTED';

CREATE TABLE IF NOT EXISTS public.followup_case_members (
  followup_case_id uuid NOT NULL
    REFERENCES public.followup_cases(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  source_sync_run_id uuid NULL
    REFERENCES public.sync_runs(id) ON DELETE SET NULL,
  order_code text NOT NULL,
  customer_id text NOT NULL,
  warehouse_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('DELIVERY', 'TRANSIT', 'OUTBOUND', 'UNKNOWN')),
  status text NOT NULL,
  observed_at timestamptz NOT NULL,
  ready_at timestamptz NULL,
  source text NULL CHECK (source IS NULL OR source IN ('rillnet', 'ghn_internal_order_logs')),
  baseline_status text NOT NULL,
  is_baseline boolean NOT NULL,
  due_at timestamptz NULL,
  last_reminder_at timestamptz NULL,
  last_reminder_status text NULL,
  completed_at timestamptz NULL,
  member_active boolean NOT NULL DEFAULT true,
  verification_failure text NULL,
  CONSTRAINT followup_case_members_pkey
    PRIMARY KEY (followup_case_id, generation_id, order_code),
  CONSTRAINT followup_case_members_generation_fkey
    FOREIGN KEY (followup_case_id, generation_id)
    REFERENCES public.followup_case_member_generations(followup_case_id, generation_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.followup_case_cohort_archive (
  followup_case_id uuid NOT NULL
    REFERENCES public.followup_cases(id) ON DELETE RESTRICT,
  original_operational_cohort jsonb NOT NULL,
  backfill_generation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_case_updated_at timestamptz NULL,
  source_cohort_sha256 text NOT NULL,
  CONSTRAINT followup_case_cohort_archive_pkey PRIMARY KEY (followup_case_id),
  CONSTRAINT followup_case_cohort_archive_hash_format
    CHECK (source_cohort_sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.followup_case_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followup_case_member_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followup_case_cohort_archive ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.followup_case_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.followup_case_member_generations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.followup_case_cohort_archive FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.followup_case_members TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.followup_case_member_generations TO service_role;
GRANT SELECT, INSERT ON TABLE public.followup_case_cohort_archive TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.followup_case_cohort_archive FROM service_role;

-- Operator-only bounded cleanup. It is never called from job 14 or the
-- checkpoint path. Dry run is the default; apply removes at most the caller's
-- bounded member-row budget in one invocation.
CREATE OR REPLACE FUNCTION public.cleanup_followup_case_member_generations(
  p_dry_run boolean DEFAULT true,
  p_case_limit integer DEFAULT 5,
  p_member_delete_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_case record;
  v_generation record;
  v_deleted integer := 0;
  v_generations_deleted integer := 0;
  v_candidate_generations integer := 0;
  v_candidate_members bigint := 0;
  v_case_remaining integer;
  v_deleted_this integer;
  v_grace constant interval := interval '7 days';
BEGIN
  IF p_case_limit < 1 OR p_case_limit > 20
    OR p_member_delete_limit < 1 OR p_member_delete_limit > 10000 THEN
    RAISE EXCEPTION 'FOLLOWUP_GENERATION_CLEANUP_LIMIT_OUT_OF_RANGE';
  END IF;

  IF p_dry_run THEN
    WITH candidate_cases AS (
      SELECT fc.id, fc.member_generation_id
      FROM public.followup_cases AS fc
      WHERE EXISTS (
        SELECT 1
        FROM (
          SELECT g.followup_case_id, g.generation_id, g.generation_status,
            g.created_at, g.source_sync_run_id,
            row_number() OVER (
              PARTITION BY g.followup_case_id
              ORDER BY g.committed_at DESC NULLS LAST, g.created_at DESC, g.generation_id DESC
            ) AS committed_rank
          FROM public.followup_case_member_generations AS g
          JOIN public.followup_cases AS owner_case ON owner_case.id = g.followup_case_id
          WHERE g.generation_status = 'COMMITTED'
            AND g.generation_id IS DISTINCT FROM owner_case.member_generation_id
        ) AS ranked
        WHERE ranked.followup_case_id = fc.id
          AND ranked.committed_rank > 1
          AND NOT EXISTS (
            SELECT 1 FROM public.sync_runs AS sr
            WHERE sr.id = ranked.source_sync_run_id
              AND (sr.status = 'running' OR (sr.status = 'failed' AND ranked.created_at >= clock_timestamp() - v_grace))
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.checkpoint_recoveries AS cr
            WHERE cr.sync_run_id = ranked.source_sync_run_id
              AND cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')
          )
      ) OR EXISTS (
        SELECT 1 FROM public.followup_case_member_generations AS abandoned
        WHERE abandoned.followup_case_id = fc.id
          AND abandoned.generation_status = 'PREPARING'
          AND abandoned.created_at < clock_timestamp() - v_grace
          AND abandoned.generation_id IS DISTINCT FROM fc.member_generation_id
          AND NOT EXISTS (
            SELECT 1 FROM public.sync_runs AS sr
            WHERE sr.id = abandoned.source_sync_run_id AND sr.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.checkpoint_recoveries AS cr
            WHERE cr.sync_run_id = abandoned.source_sync_run_id
              AND cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')
          )
      )
      ORDER BY fc.id
      LIMIT p_case_limit
    ), candidate_generations AS (
      SELECT g.followup_case_id, g.generation_id
      FROM candidate_cases AS fc
      JOIN public.followup_case_member_generations AS g ON g.followup_case_id = fc.id
      LEFT JOIN (
        SELECT followup_case_id, generation_id,
          row_number() OVER (
            PARTITION BY followup_case_id
            ORDER BY committed_at DESC NULLS LAST, created_at DESC, generation_id DESC
          ) AS committed_rank
        FROM public.followup_case_member_generations AS committed
        JOIN public.followup_cases AS owner_case ON owner_case.id = committed.followup_case_id
        WHERE committed.generation_status = 'COMMITTED'
          AND committed.generation_id IS DISTINCT FROM owner_case.member_generation_id
      ) AS ranked USING (followup_case_id, generation_id)
      WHERE g.generation_id IS DISTINCT FROM fc.member_generation_id
        AND (
          (g.generation_status = 'COMMITTED' AND ranked.committed_rank > 1)
          OR (g.generation_status = 'PREPARING' AND g.created_at < clock_timestamp() - v_grace)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.sync_runs AS sr
          WHERE sr.id = g.source_sync_run_id
            AND (sr.status = 'running' OR (sr.status = 'failed' AND g.created_at >= clock_timestamp() - v_grace))
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.checkpoint_recoveries AS cr
          WHERE cr.sync_run_id = g.source_sync_run_id
            AND cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')
        )
    )
    SELECT count(*)::integer,
      coalesce(sum((SELECT count(*) FROM public.followup_case_members AS m
        WHERE m.followup_case_id = cg.followup_case_id AND m.generation_id = cg.generation_id)), 0)::bigint
    INTO v_candidate_generations, v_candidate_members
    FROM candidate_generations AS cg;

    RETURN jsonb_build_object(
      'dryRun', true,
      'graceWindow', v_grace::text,
      'caseLimit', p_case_limit,
      'memberDeleteLimit', p_member_delete_limit,
      'eligibleGenerationsInBatch', v_candidate_generations,
      'eligibleMemberRowsInBatch', v_candidate_members,
      'deletedMemberRows', 0,
      'deletedGenerations', 0
    );
  END IF;

  FOR v_case IN
    SELECT fc.id, fc.member_generation_id
    FROM public.followup_cases AS fc
    WHERE EXISTS (
      SELECT 1 FROM public.followup_case_member_generations AS g
      WHERE g.followup_case_id = fc.id
        AND g.generation_id IS DISTINCT FROM fc.member_generation_id
        AND (
          (g.generation_status = 'COMMITTED' AND (
            SELECT count(*) FROM public.followup_case_member_generations AS newer
            WHERE newer.followup_case_id = g.followup_case_id
              AND newer.generation_status = 'COMMITTED'
              AND newer.generation_id IS DISTINCT FROM fc.member_generation_id
              AND (newer.committed_at, newer.created_at, newer.generation_id)
                > (g.committed_at, g.created_at, g.generation_id)
          ) >= 1)
          OR (g.generation_status = 'PREPARING' AND g.created_at < clock_timestamp() - v_grace)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.sync_runs AS sr
          WHERE sr.id = g.source_sync_run_id
            AND (sr.status = 'running' OR (sr.status = 'failed' AND g.created_at >= clock_timestamp() - v_grace))
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.checkpoint_recoveries AS cr
          WHERE cr.sync_run_id = g.source_sync_run_id
            AND cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')
        )
    )
    ORDER BY fc.id
    LIMIT p_case_limit
    FOR UPDATE OF fc SKIP LOCKED
  LOOP
    FOR v_generation IN
      SELECT g.generation_id
      FROM public.followup_case_member_generations AS g
      WHERE g.followup_case_id = v_case.id
        AND g.generation_id IS DISTINCT FROM v_case.member_generation_id
        AND (
          (g.generation_status = 'COMMITTED' AND (
            SELECT count(*) FROM public.followup_case_member_generations AS newer
            WHERE newer.followup_case_id = g.followup_case_id
              AND newer.generation_status = 'COMMITTED'
              AND newer.generation_id IS DISTINCT FROM v_case.member_generation_id
              AND (newer.committed_at, newer.created_at, newer.generation_id)
                > (g.committed_at, g.created_at, g.generation_id)
          ) >= 1)
          OR (g.generation_status = 'PREPARING' AND g.created_at < clock_timestamp() - v_grace)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.sync_runs AS sr
          WHERE sr.id = g.source_sync_run_id
            AND (sr.status = 'running' OR (sr.status = 'failed' AND g.created_at >= clock_timestamp() - v_grace))
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.checkpoint_recoveries AS cr
          WHERE cr.sync_run_id = g.source_sync_run_id
            AND cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')
        )
      ORDER BY g.created_at, g.generation_id
    LOOP
      v_case_remaining := p_member_delete_limit - v_deleted;
      EXIT WHEN v_case_remaining <= 0;

      WITH delete_batch AS (
        SELECT ctid FROM public.followup_case_members
        WHERE followup_case_id = v_case.id AND generation_id = v_generation.generation_id
        LIMIT v_case_remaining
      )
      DELETE FROM public.followup_case_members AS m
      USING delete_batch AS d
      WHERE m.ctid = d.ctid;
      GET DIAGNOSTICS v_deleted_this = ROW_COUNT;
      v_deleted := v_deleted + v_deleted_this;

      IF NOT EXISTS (
        SELECT 1 FROM public.followup_case_members AS m
        WHERE m.followup_case_id = v_case.id AND m.generation_id = v_generation.generation_id
      ) THEN
        DELETE FROM public.followup_case_member_generations AS g
        WHERE g.followup_case_id = v_case.id AND g.generation_id = v_generation.generation_id;
        v_generations_deleted := v_generations_deleted + 1;
      END IF;
    END LOOP;
    EXIT WHEN v_deleted >= p_member_delete_limit;
  END LOOP;

  RETURN jsonb_build_object(
    'dryRun', false,
    'graceWindow', v_grace::text,
    'caseLimit', p_case_limit,
    'memberDeleteLimit', p_member_delete_limit,
    'deletedMemberRows', v_deleted,
    'deletedGenerations', v_generations_deleted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) TO service_role;

COMMIT;
