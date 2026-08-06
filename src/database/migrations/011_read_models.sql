-- Migration 011: Read Model tables and atomic RPC functions
-- ------------------------------------------------------------
-- Dashboard Snapshot (materialised KPI columns + metadata JSONB)
CREATE TABLE IF NOT EXISTS dashboard_snapshot (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('ALL','REGION','WAREHOUSE')),
    scope_key TEXT NOT NULL,
    projection_version INT NOT NULL DEFAULT 1,
    total_warehouses INT NOT NULL DEFAULT 0,
    active_incidents INT NOT NULL DEFAULT 0,
    critical_incidents INT NOT NULL DEFAULT 0,
    high_priority_incidents INT NOT NULL DEFAULT 0,
    open_followups INT NOT NULL DEFAULT 0,
    pending_notifications INT NOT NULL DEFAULT 0,
    failed_notifications INT NOT NULL DEFAULT 0,
    planner_pending INT NOT NULL DEFAULT 0,
    ai_jobs_pending INT NOT NULL DEFAULT 0,
    ai_jobs_running INT NOT NULL DEFAULT 0,
    last_sync_at TIMESTAMP,
    overall_health TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (scope_type, scope_key, projection_version)
);

-- Warehouse Summary (one row per warehouse)
CREATE TABLE IF NOT EXISTS warehouse_summary (
    warehouse_id TEXT PRIMARY KEY,
    warehouse_name TEXT,
    active_incidents INT NOT NULL DEFAULT 0,
    critical_incidents INT NOT NULL DEFAULT 0,
    followups_waiting INT NOT NULL DEFAULT 0,
    notifications_pending INT NOT NULL DEFAULT 0,
    planner_drafts INT NOT NULL DEFAULT 0,
    average_age_hours NUMERIC,
    health TEXT,
    last_sync TIMESTAMP,
    projection_version INT NOT NULL DEFAULT 1,
    last_projection_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Incident Summary (one row per incident)
CREATE TABLE IF NOT EXISTS incident_summary (
    incident_id UUID PRIMARY KEY,
    priority TEXT,
    trend TEXT,
    risk TEXT,
    followup_state TEXT,
    planner_status TEXT,
    notification_status TEXT,
    latest_root_cause_confidence NUMERIC,
    latest_planner_confidence NUMERIC,
    projection_version INT NOT NULL DEFAULT 1,
    last_projection_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Planner Summary (latest recommendation per incident)
CREATE TABLE IF NOT EXISTS planner_summary (
    incident_id UUID PRIMARY KEY,
    recommendation JSONB,
    approval_state TEXT,
    confidence NUMERIC,
    next_review TIMESTAMP,
    review_actor TEXT,
    projection_version INT NOT NULL DEFAULT 1,
    last_projection_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Notification Summary (one row per incident)
CREATE TABLE IF NOT EXISTS notification_summary (
    incident_id UUID PRIMARY KEY,
    pending INT NOT NULL DEFAULT 0,
    sent INT NOT NULL DEFAULT 0,
    failed INT NOT NULL DEFAULT 0,
    retry INT NOT NULL DEFAULT 0,
    simulation BOOLEAN NOT NULL DEFAULT false,
    last_delivery TIMESTAMP,
    projection_version INT NOT NULL DEFAULT 1,
    last_projection_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Projection Runs (diagnostics)
CREATE TABLE IF NOT EXISTS projection_runs (
    run_id UUID PRIMARY KEY,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    duration_ms INT,
    status TEXT NOT NULL CHECK (status IN ('running','success','partial_success','failed')),
    source TEXT NOT NULL CHECK (source IN ('sync','planner','followup','notification','manual_rebuild','retry')),
    mode TEXT NOT NULL CHECK (mode IN ('incremental','full')),
    projection_version INT NOT NULL DEFAULT 1,
    results JSONB NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- ------------------------------------------------------------
-- RPC Functions for atomic upsert + stale deletion
-- ------------------------------------------------------------

-- Warehouse Summary RPC
CREATE OR REPLACE FUNCTION upsert_warehouse_summary(
    rows JSONB,
    present_ids TEXT[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO warehouse_summary (warehouse_id, warehouse_name, active_incidents, critical_incidents, followups_waiting, notifications_pending, planner_drafts, average_age_hours, health, last_sync, projection_version, last_projection_at, created_at, updated_at)
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
        warehouse_name = EXCLUDED.warehouse_name,
        active_incidents = EXCLUDED.active_incidents,
        critical_incidents = EXCLUDED.critical_incidents,
        followups_waiting = EXCLUDED.followups_waiting,
        notifications_pending = EXCLUDED.notifications_pending,
        planner_drafts = EXCLUDED.planner_drafts,
        average_age_hours = EXCLUDED.average_age_hours,
        health = EXCLUDED.health,
        last_sync = EXCLUDED.last_sync,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at = now();

    DELETE FROM warehouse_summary WHERE warehouse_id <> ALL (present_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Incident Summary RPC
CREATE OR REPLACE FUNCTION upsert_incident_summary(
    rows JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO incident_summary (incident_id, priority, trend, risk, followup_state, planner_status, notification_status, latest_root_cause_confidence, latest_planner_confidence, projection_version, last_projection_at, created_at, updated_at)
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
        priority = EXCLUDED.priority,
        trend = EXCLUDED.trend,
        risk = EXCLUDED.risk,
        followup_state = EXCLUDED.followup_state,
        planner_status = EXCLUDED.planner_status,
        notification_status = EXCLUDED.notification_status,
        latest_root_cause_confidence = EXCLUDED.latest_root_cause_confidence,
        latest_planner_confidence = EXCLUDED.latest_planner_confidence,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at = now();

    DELETE FROM incident_summary WHERE incident_id <> ALL (present_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Planner Summary RPC
CREATE OR REPLACE FUNCTION upsert_planner_summary(
    rows JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO planner_summary (incident_id, recommendation, approval_state, confidence, next_review, review_actor, projection_version, last_projection_at, created_at, updated_at)
    SELECT
        (r->>'incident_id')::UUID,
        r->>'recommendation'::JSONB,
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
        recommendation = EXCLUDED.recommendation,
        approval_state = EXCLUDED.approval_state,
        confidence = EXCLUDED.confidence,
        next_review = EXCLUDED.next_review,
        review_actor = EXCLUDED.review_actor,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at = now();

    DELETE FROM planner_summary WHERE incident_id <> ALL (present_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Notification Summary RPC
CREATE OR REPLACE FUNCTION upsert_notification_summary(
    rows JSONB,
    present_ids UUID[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO notification_summary (incident_id, pending, sent, failed, retry, simulation, last_delivery, projection_version, last_projection_at, created_at, updated_at)
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
        pending = EXCLUDED.pending,
        sent = EXCLUDED.sent,
        failed = EXCLUDED.failed,
        retry = EXCLUDED.retry,
        simulation = EXCLUDED.simulation,
        last_delivery = EXCLUDED.last_delivery,
        projection_version = EXCLUDED.projection_version,
        last_projection_at = EXCLUDED.last_projection_at,
        updated_at = now();

    DELETE FROM notification_summary WHERE incident_id <> ALL (present_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Dashboard Snapshot RPC (full upsert – assumes caller has already calculated KPI values and metadata JSON)
CREATE OR REPLACE FUNCTION upsert_dashboard_snapshot(
    p_scope_type TEXT,
    p_scope_key TEXT,
    p_kpis JSONB,
    p_metadata JSONB,
    p_projection_version INT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO dashboard_snapshot (
        scope_type,
        scope_key,
        projection_version,
        total_warehouses,
        active_incidents,
        critical_incidents,
        high_priority_incidents,
        open_followups,
        pending_notifications,
        failed_notifications,
        planner_pending,
        ai_jobs_pending,
        ai_jobs_running,
        last_sync_at,
        overall_health,
        metadata,
        created_at,
        updated_at,
        last_projection_at
    )
    VALUES (
        p_scope_type,
        p_scope_key,
        p_projection_version,
        (p_kpis->>'total_warehouses')::INT,
        (p_kpis->>'active_incidents')::INT,
        (p_kpis->>'critical_incidents')::INT,
        (p_kpis->>'high_priority_incidents')::INT,
        (p_kpis->>'open_followups')::INT,
        (p_kpis->>'pending_notifications')::INT,
        (p_kpis->>'failed_notifications')::INT,
        (p_kpis->>'planner_pending')::INT,
        (p_kpis->>'ai_jobs_pending')::INT,
        (p_kpis->>'ai_jobs_running')::INT,
        (p_kpis->>'last_sync_at')::TIMESTAMP,
        p_kpis->>'overall_health',
        p_metadata,
        now(),
        now(),
        now()
    )
    ON CONFLICT (scope_type, scope_key, projection_version) DO UPDATE SET
        total_warehouses = EXCLUDED.total_warehouses,
        active_incidents = EXCLUDED.active_incidents,
        critical_incidents = EXCLUDED.critical_incidents,
        high_priority_incidents = EXCLUDED.high_priority_incidents,
        open_followups = EXCLUDED.open_followups,
        pending_notifications = EXCLUDED.pending_notifications,
        failed_notifications = EXCLUDED.failed_notifications,
        planner_pending = EXCLUDED.planner_pending,
        ai_jobs_pending = EXCLUDED.ai_jobs_pending,
        ai_jobs_running = EXCLUDED.ai_jobs_running,
        last_sync_at = EXCLUDED.last_sync_at,
        overall_health = EXCLUDED.overall_health,
        metadata = EXCLUDED.metadata,
        updated_at = now(),
        last_projection_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- End of Migration 011