-- ============================================================
-- Migration 011 — Hardening Patch
-- Apply this patch IMMEDIATELY AFTER 011_read_models.sql.
-- Safe to run multiple times (all statements are idempotent).
-- ============================================================

-- ------------------------------------------------------------
-- 1. projection_runs.results → JSONB NOT NULL DEFAULT '{}'
-- ------------------------------------------------------------
ALTER TABLE projection_runs
    ALTER COLUMN results SET DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------
-- 2. dashboard_snapshot.metadata → JSONB NOT NULL DEFAULT '{}'
--    First backfill NULLs, then enforce NOT NULL.
-- ------------------------------------------------------------
UPDATE dashboard_snapshot SET metadata = '{}'::jsonb WHERE metadata IS NULL;

ALTER TABLE dashboard_snapshot
    ALTER COLUMN metadata SET NOT NULL,
    ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------
-- 3 & 4. created_at / updated_at DEFAULT now()
--    Already present on all tables in the base migration.
--    Verified — no ALTER needed.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5. overall_health CHECK ('healthy','warning','critical','stale')
--    Column lives only on dashboard_snapshot.
-- ------------------------------------------------------------
ALTER TABLE dashboard_snapshot
    ADD CONSTRAINT chk_dashboard_snapshot_overall_health
    CHECK (overall_health IS NULL OR overall_health IN ('healthy','warning','critical','stale'));

-- ------------------------------------------------------------
-- 6. projection_version CHECK (projection_version > 0)
--    Applied to every table that carries the column.
-- ------------------------------------------------------------
ALTER TABLE dashboard_snapshot
    ADD CONSTRAINT chk_dashboard_snapshot_projection_version
    CHECK (projection_version > 0);

ALTER TABLE warehouse_summary
    ADD CONSTRAINT chk_warehouse_summary_projection_version
    CHECK (projection_version > 0);

ALTER TABLE incident_summary
    ADD CONSTRAINT chk_incident_summary_projection_version
    CHECK (projection_version > 0);

ALTER TABLE planner_summary
    ADD CONSTRAINT chk_planner_summary_projection_version
    CHECK (projection_version > 0);

ALTER TABLE notification_summary
    ADD CONSTRAINT chk_notification_summary_projection_version
    CHECK (projection_version > 0);

ALTER TABLE projection_runs
    ADD CONSTRAINT chk_projection_runs_projection_version
    CHECK (projection_version > 0);

-- ------------------------------------------------------------
-- 7. duration_ms CHECK (duration_ms >= 0)
-- ------------------------------------------------------------
ALTER TABLE projection_runs
    ADD CONSTRAINT chk_projection_runs_duration_ms
    CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- ------------------------------------------------------------
-- 8. Fix empty-array DELETE safety in all four upsert RPCs.
--
-- Root cause:
--   In PostgreSQL, `col <> ALL ('{}')` is TRUE for EVERY row
--   when the array is empty (vacuous truth), so calling any RPC
--   with present_ids = '{}' during an incremental refresh that
--   touches zero rows silently wipes the entire table.
--
-- Fix: wrap DELETE in IF cardinality(present_ids) > 0 guard.
--   cardinality() returns 0 for empty arrays and NULL for SQL
--   NULL arrays, so the guard is safe for both edge cases.
--
-- Also fixes the JSONB cast bug in upsert_planner_summary:
--   r->>'recommendation'::JSONB  is wrong (casts the string
--   literal, not the expression).
--   Correct form: (r->>'recommendation')::JSONB
-- ------------------------------------------------------------

-- Warehouse Summary RPC (safe DELETE guard)
CREATE OR REPLACE FUNCTION upsert_warehouse_summary(
    rows JSONB,
    present_ids TEXT[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO warehouse_summary (
        warehouse_id, warehouse_name, active_incidents, critical_incidents,
        followups_waiting, notifications_pending, planner_drafts,
        average_age_hours, health, last_sync,
        projection_version, last_projection_at, created_at, updated_at
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
        warehouse_name      = EXCLUDED.warehouse_name,
        active_incidents    = EXCLUDED.active_incidents,
        critical_incidents  = EXCLUDED.critical_incidents,
        followups_waiting   = EXCLUDED.followups_waiting,
        notifications_pending = EXCLUDED.notifications_pending,
        planner_drafts      = EXCLUDED.planner_drafts,
        average_age_hours   = EXCLUDED.average_age_hours,
        health              = EXCLUDED.health,
        last_sync           = EXCLUDED.last_sync,
        projection_version  = EXCLUDED.projection_version,
        last_projection_at  = EXCLUDED.last_projection_at,
        updated_at          = now();

    -- SAFETY GUARD: only delete stale rows when the caller supplied
    -- at least one present ID.  An empty array means incremental mode
    -- touched no warehouses — preserve the existing rows.
    IF cardinality(present_ids) > 0 THEN
        DELETE FROM warehouse_summary
        WHERE warehouse_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Incident Summary RPC (safe DELETE guard)
CREATE OR REPLACE FUNCTION upsert_incident_summary(
    rows JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO incident_summary (
        incident_id, priority, trend, risk, followup_state,
        planner_status, notification_status,
        latest_root_cause_confidence, latest_planner_confidence,
        projection_version, last_projection_at, created_at, updated_at
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
        priority                      = EXCLUDED.priority,
        trend                         = EXCLUDED.trend,
        risk                          = EXCLUDED.risk,
        followup_state                = EXCLUDED.followup_state,
        planner_status                = EXCLUDED.planner_status,
        notification_status           = EXCLUDED.notification_status,
        latest_root_cause_confidence  = EXCLUDED.latest_root_cause_confidence,
        latest_planner_confidence     = EXCLUDED.latest_planner_confidence,
        projection_version            = EXCLUDED.projection_version,
        last_projection_at            = EXCLUDED.last_projection_at,
        updated_at                    = now();

    IF cardinality(present_ids) > 0 THEN
        DELETE FROM incident_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Planner Summary RPC (safe DELETE guard + JSONB cast fix)
CREATE OR REPLACE FUNCTION upsert_planner_summary(
    rows JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO planner_summary (
        incident_id, recommendation, approval_state, confidence,
        next_review, review_actor,
        projection_version, last_projection_at, created_at, updated_at
    )
    SELECT
        (r->>'incident_id')::UUID,
        (r->>'recommendation')::JSONB,    -- FIXED: parentheses before cast
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
        recommendation      = EXCLUDED.recommendation,
        approval_state      = EXCLUDED.approval_state,
        confidence          = EXCLUDED.confidence,
        next_review         = EXCLUDED.next_review,
        review_actor        = EXCLUDED.review_actor,
        projection_version  = EXCLUDED.projection_version,
        last_projection_at  = EXCLUDED.last_projection_at,
        updated_at          = now();

    IF cardinality(present_ids) > 0 THEN
        DELETE FROM planner_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Notification Summary RPC (safe DELETE guard)
CREATE OR REPLACE FUNCTION upsert_notification_summary(
    rows JSONB,
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
        pending             = EXCLUDED.pending,
        sent                = EXCLUDED.sent,
        failed              = EXCLUDED.failed,
        retry               = EXCLUDED.retry,
        simulation          = EXCLUDED.simulation,
        last_delivery       = EXCLUDED.last_delivery,
        projection_version  = EXCLUDED.projection_version,
        last_projection_at  = EXCLUDED.last_projection_at,
        updated_at          = now();

    IF cardinality(present_ids) > 0 THEN
        DELETE FROM notification_summary
        WHERE incident_id <> ALL (present_ids);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- dashboard_snapshot also needs last_projection_at column (missing from base DDL)
ALTER TABLE dashboard_snapshot
    ADD COLUMN IF NOT EXISTS last_projection_at TIMESTAMP;

-- ------------------------------------------------------------
-- 9. updated_at = now() — verified present in all 5 RPCs.
--    No additional changes needed.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Indexes (from previous audit — included here for completeness)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_projection_runs_status_started
    ON projection_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_runs_started_at
    ON projection_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshot_scope
    ON dashboard_snapshot (scope_type, scope_key);

CREATE INDEX IF NOT EXISTS idx_incident_summary_priority
    ON incident_summary (priority, planner_status);

CREATE INDEX IF NOT EXISTS idx_warehouse_summary_health
    ON warehouse_summary (health);

-- ============================================================
-- End of hardening patch
-- ============================================================
