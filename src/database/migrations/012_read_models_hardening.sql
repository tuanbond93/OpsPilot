-- ============================================================
-- Migration 012: Read Model Hardening
-- Applies production-grade fixes to tables and RPC functions
-- created by migration 011_read_models.sql.
--
-- Safe to run multiple times:
--   - ADD COLUMN IF NOT EXISTS
--   - ADD CONSTRAINT … NOT VALID then VALIDATE (skipped if exists via DO block)
--   - CREATE OR REPLACE FUNCTION
--   - CREATE INDEX IF NOT EXISTS
--   - ALTER COLUMN SET DEFAULT is idempotent
--   - UPDATE … WHERE IS NULL is a no-op after first run
-- ============================================================

-- ============================================================
-- 1. Add missing last_projection_at column to dashboard_snapshot
--    (referenced in upsert_dashboard_snapshot RPC but absent
--    from the original CREATE TABLE DDL — would cause a runtime
--    error on every dashboard projection write)
-- ============================================================
ALTER TABLE dashboard_snapshot
    ADD COLUMN IF NOT EXISTS last_projection_at TIMESTAMP;

-- ============================================================
-- 2. projection_runs.results → JSONB NOT NULL DEFAULT '{}'
--    Original column had NOT NULL but no DEFAULT, causing insert
--    failures when the caller omits the field.
-- ============================================================
ALTER TABLE projection_runs
    ALTER COLUMN results SET DEFAULT '{}'::jsonb;

-- ============================================================
-- 3. dashboard_snapshot.metadata → JSONB NOT NULL DEFAULT '{}'
--    Original column was nullable with no default.
--    Backfill existing NULLs before enforcing NOT NULL.
-- ============================================================
UPDATE dashboard_snapshot
    SET metadata = '{}'::jsonb
WHERE metadata IS NULL;

ALTER TABLE dashboard_snapshot
    ALTER COLUMN metadata SET NOT NULL,
    ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

-- ============================================================
-- 4. overall_health CHECK constraint
--    ('healthy', 'warning', 'critical', 'stale')
--    IS NULL allowed: a degraded or incomplete snapshot may
--    legitimately have no health value set yet.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'dashboard_snapshot'
          AND constraint_name = 'chk_dashboard_snapshot_overall_health'
    ) THEN
        ALTER TABLE dashboard_snapshot
            ADD CONSTRAINT chk_dashboard_snapshot_overall_health
            CHECK (overall_health IS NULL
                OR overall_health IN ('healthy','warning','critical','stale'));
    END IF;
END;
$$;

-- ============================================================
-- 5. projection_version CHECK (projection_version > 0)
--    Applied to every table that carries the column.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'dashboard_snapshot'
          AND constraint_name = 'chk_dashboard_snapshot_projection_version'
    ) THEN
        ALTER TABLE dashboard_snapshot
            ADD CONSTRAINT chk_dashboard_snapshot_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'warehouse_summary'
          AND constraint_name = 'chk_warehouse_summary_projection_version'
    ) THEN
        ALTER TABLE warehouse_summary
            ADD CONSTRAINT chk_warehouse_summary_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'incident_summary'
          AND constraint_name = 'chk_incident_summary_projection_version'
    ) THEN
        ALTER TABLE incident_summary
            ADD CONSTRAINT chk_incident_summary_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'planner_summary'
          AND constraint_name = 'chk_planner_summary_projection_version'
    ) THEN
        ALTER TABLE planner_summary
            ADD CONSTRAINT chk_planner_summary_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'notification_summary'
          AND constraint_name = 'chk_notification_summary_projection_version'
    ) THEN
        ALTER TABLE notification_summary
            ADD CONSTRAINT chk_notification_summary_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'projection_runs'
          AND constraint_name = 'chk_projection_runs_projection_version'
    ) THEN
        ALTER TABLE projection_runs
            ADD CONSTRAINT chk_projection_runs_projection_version
            CHECK (projection_version > 0);
    END IF;
END;
$$;

-- ============================================================
-- 6. duration_ms CHECK (duration_ms >= 0)
--    IS NULL allowed: column is NULL until the run finishes.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'projection_runs'
          AND constraint_name = 'chk_projection_runs_duration_ms'
    ) THEN
        ALTER TABLE projection_runs
            ADD CONSTRAINT chk_projection_runs_duration_ms
            CHECK (duration_ms IS NULL OR duration_ms >= 0);
    END IF;
END;
$$;

-- ============================================================
-- 7. Performance indexes
-- ============================================================

-- projection_runs: diagnostics endpoint sorts by status + time
CREATE INDEX IF NOT EXISTS idx_projection_runs_status_started
    ON projection_runs (status, started_at DESC);

-- projection_runs: latest-first listing
CREATE INDEX IF NOT EXISTS idx_projection_runs_started_at
    ON projection_runs (started_at DESC);

-- dashboard_snapshot: scope lookup (omits projection_version)
CREATE INDEX IF NOT EXISTS idx_dashboard_snapshot_scope
    ON dashboard_snapshot (scope_type, scope_key);

-- incident_summary: filtered dashboard and planner reads
CREATE INDEX IF NOT EXISTS idx_incident_summary_priority
    ON incident_summary (priority, planner_status);

-- warehouse_summary: health-filtered dashboard tiles
CREATE INDEX IF NOT EXISTS idx_warehouse_summary_health
    ON warehouse_summary (health);

-- ============================================================
-- 8. Replace all four upsert RPC functions with hardened versions.
--
-- Two bugs fixed in every function:
--
--   BUG A — Empty-array silent full-table wipe:
--     In PostgreSQL, `col <> ALL('{}')` evaluates to TRUE for
--     every row when the array is empty (vacuous truth). Calling
--     any RPC with present_ids = '{}' (e.g., during an incremental
--     run that touches zero rows) deletes the entire summary table.
--     Fix: guard with IF cardinality(present_ids) > 0.
--     cardinality() returns 0 for empty arrays and NULL for SQL
--     NULL arrays, so both edge cases are covered.
--
--   BUG B — JSONB cast operator-precedence error (planner only):
--     r->>'recommendation'::JSONB casts the string literal 'JSONB',
--     not the expression result. Postgres resolves this as:
--     r->>('recommendation'::JSONB) which is a type error.
--     Fix: (r->>'recommendation')::JSONB
--
-- All functions use CREATE OR REPLACE — idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 8a. upsert_warehouse_summary
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_warehouse_summary(
    rows        JSONB,
    present_ids TEXT[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO warehouse_summary (
        warehouse_id, warehouse_name,
        active_incidents, critical_incidents,
        followups_waiting, notifications_pending, planner_drafts,
        average_age_hours, health, last_sync,
        projection_version, last_projection_at,
        created_at, updated_at
    )
    SELECT
        (r->>'warehouse_id')::TEXT,
        r->>'warehouse_name',
        (r->>'active_incidents')::INT,
        (r->>'critical_incidents')::INT,
        (r->>'followups_waiting')::INT,
        (r->>'notifications_pending')::INT,
        (r->>'planner_drafts')::INT,
        (r->>'average_age_hours')::NUMERIC,
        r->>'health',
        (r->>'last_sync')::TIMESTAMP,
        1,
        now(),
        now(),
        now()
    FROM jsonb_array_elements(rows) AS r
    ON CONFLICT (warehouse_id) DO UPDATE SET
        warehouse_name        = EXCLUDED.warehouse_name,
        active_incidents      = EXCLUDED.active_incidents,
        critical_incidents    = EXCLUDED.critical_incidents,
        followups_waiting     = EXCLUDED.followups_waiting,
        notifications_pending = EXCLUDED.notifications_pending,
        planner_drafts        = EXCLUDED.planner_drafts,
        average_age_hours     = EXCLUDED.average_age_hours,
        health                = EXCLUDED.health,
        last_sync             = EXCLUDED.last_sync,
        projection_version    = EXCLUDED.projection_version,
        last_projection_at    = EXCLUDED.last_projection_at,
        updated_at            = now();

    -- BUG A FIX: skip DELETE when present_ids is empty.
    -- An empty array means incremental mode touched no warehouses —
    -- preserve all existing rows unchanged.
    IF cardinality(present_ids) > 0 THEN
        DELETE FROM warehouse_summary
        WHERE warehouse_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 8b. upsert_incident_summary
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_incident_summary(
    rows        JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO incident_summary (
        incident_id, priority, trend, risk,
        followup_state, planner_status, notification_status,
        latest_root_cause_confidence, latest_planner_confidence,
        projection_version, last_projection_at,
        created_at, updated_at
    )
    SELECT
        (r->>'incident_id')::UUID,
        r->>'priority',
        r->>'trend',
        r->>'risk',
        r->>'followup_state',
        r->>'planner_status',
        r->>'notification_status',
        (r->>'latest_root_cause_confidence')::NUMERIC,
        (r->>'latest_planner_confidence')::NUMERIC,
        1,
        now(),
        now(),
        now()
    FROM jsonb_array_elements(rows) AS r
    ON CONFLICT (incident_id) DO UPDATE SET
        priority                     = EXCLUDED.priority,
        trend                        = EXCLUDED.trend,
        risk                         = EXCLUDED.risk,
        followup_state               = EXCLUDED.followup_state,
        planner_status               = EXCLUDED.planner_status,
        notification_status          = EXCLUDED.notification_status,
        latest_root_cause_confidence = EXCLUDED.latest_root_cause_confidence,
        latest_planner_confidence    = EXCLUDED.latest_planner_confidence,
        projection_version           = EXCLUDED.projection_version,
        last_projection_at           = EXCLUDED.last_projection_at,
        updated_at                   = now();

    -- BUG A FIX
    IF cardinality(present_ids) > 0 THEN
        DELETE FROM incident_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 8c. upsert_planner_summary (also fixes BUG B — JSONB cast)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_planner_summary(
    rows        JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO planner_summary (
        incident_id, recommendation, approval_state,
        confidence, next_review, review_actor,
        projection_version, last_projection_at,
        created_at, updated_at
    )
    SELECT
        (r->>'incident_id')::UUID,
        (r->>'recommendation')::JSONB,   -- BUG B FIX: parens before ::JSONB
        r->>'approval_state',
        (r->>'confidence')::NUMERIC,
        (r->>'next_review')::TIMESTAMP,
        r->>'review_actor',
        1,
        now(),
        now(),
        now()
    FROM jsonb_array_elements(rows) AS r
    ON CONFLICT (incident_id) DO UPDATE SET
        recommendation     = EXCLUDED.recommendation,
        approval_state     = EXCLUDED.approval_state,
        confidence         = EXCLUDED.confidence,
        next_review        = EXCLUDED.next_review,
        review_actor       = EXCLUDED.review_actor,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at         = now();

    -- BUG A FIX
    IF cardinality(present_ids) > 0 THEN
        DELETE FROM planner_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 8d. upsert_notification_summary
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_notification_summary(
    rows        JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO notification_summary (
        incident_id, pending, sent, failed, retry, simulation,
        last_delivery, projection_version, last_projection_at,
        created_at, updated_at
    )
    SELECT
        (r->>'incident_id')::UUID,
        (r->>'pending')::INT,
        (r->>'sent')::INT,
        (r->>'failed')::INT,
        (r->>'retry')::INT,
        (r->>'simulation')::BOOLEAN,
        (r->>'last_delivery')::TIMESTAMP,
        1,
        now(),
        now(),
        now()
    FROM jsonb_array_elements(rows) AS r
    ON CONFLICT (incident_id) DO UPDATE SET
        pending            = EXCLUDED.pending,
        sent               = EXCLUDED.sent,
        failed             = EXCLUDED.failed,
        retry              = EXCLUDED.retry,
        simulation         = EXCLUDED.simulation,
        last_delivery      = EXCLUDED.last_delivery,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at         = now();

    -- BUG A FIX
    IF cardinality(present_ids) > 0 THEN
        DELETE FROM notification_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- End of Migration 012
-- ============================================================
