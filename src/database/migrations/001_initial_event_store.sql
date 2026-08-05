-- Migration 001: Initial Event Store & Operational Memory Schema for OpsPilot

-- Enable pgcrypto for gen_random_uuid if needed
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==================================================
-- 1. sync_runs Table
-- ==================================================
CREATE TABLE IF NOT EXISTS sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    fetched_order_count INTEGER NOT NULL DEFAULT 0,
    normalized_order_count INTEGER NOT NULL DEFAULT 0,
    incident_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    source_updated_at TIMESTAMPTZ,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at_desc ON sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs (status);

-- ==================================================
-- 2. order_snapshots Table
-- ==================================================
CREATE TABLE IF NOT EXISTS order_snapshots (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sync_run_id UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
    order_code TEXT NOT NULL,
    warehouse_id TEXT,
    warehouse_name TEXT,
    source_status TEXT NOT NULL,
    task_category TEXT,
    reason_code TEXT,
    order_created_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ,
    age_hours NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_order_snapshots UNIQUE(sync_run_id, order_code, warehouse_id, source_status)
);

CREATE INDEX IF NOT EXISTS idx_order_snapshots_sync_run_id ON order_snapshots (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_order_snapshots_order_code ON order_snapshots (order_code);
CREATE INDEX IF NOT EXISTS idx_order_snapshots_warehouse_id ON order_snapshots (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_order_snapshots_source_status ON order_snapshots (source_status);
CREATE INDEX IF NOT EXISTS idx_order_snapshots_reason_code ON order_snapshots (reason_code);

-- ==================================================
-- 3. incidents Table
-- ==================================================
CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_key TEXT NOT NULL UNIQUE,
    warehouse_id TEXT NOT NULL,
    warehouse_name TEXT,
    reason_code TEXT NOT NULL,
    reason_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'monitoring', 'resolved', 'ignored')),
    priority_score INTEGER NOT NULL DEFAULT 0,
    first_detected_at TIMESTAMPTZ NOT NULL,
    last_detected_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    last_sync_run_id UUID REFERENCES sync_runs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_warehouse_id ON incidents (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_priority_score_desc ON incidents (priority_score DESC);

-- Trigger to auto-update updated_at on incidents
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS trg_incidents_updated_at ON incidents;
CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ==================================================
-- 4. incident_history Table
-- ==================================================
CREATE TABLE IF NOT EXISTS incident_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    sync_run_id UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL,
    affected_order_count INTEGER NOT NULL,
    average_age_hours NUMERIC,
    maximum_age_hours NUMERIC,
    oldest_order_code TEXT,
    priority_score INTEGER NOT NULL DEFAULT 0,
    sample_order_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_incident_history_incident_sync UNIQUE(incident_id, sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_history_incident_recorded ON incident_history (incident_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_history_sync_run_id ON incident_history (sync_run_id);

-- ==================================================
-- 5. order_exceptions Table
-- ==================================================
CREATE TABLE IF NOT EXISTS order_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_code TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN ('CUSTOMER_APPOINTMENT', 'MISSING_PACKAGE', 'MISSING_DOCUMENT', 'DAMAGED', 'CS_RESCHEDULED')),
    reason_name TEXT NOT NULL,
    note TEXT,
    approved_by TEXT,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_exceptions_order_code ON order_exceptions (order_code);
CREATE INDEX IF NOT EXISTS idx_order_exceptions_active ON order_exceptions (active);
CREATE INDEX IF NOT EXISTS idx_order_exceptions_expires_at ON order_exceptions (expires_at);

DROP TRIGGER IF EXISTS trg_order_exceptions_updated_at ON order_exceptions;
CREATE TRIGGER trg_order_exceptions_updated_at
    BEFORE UPDATE ON order_exceptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
