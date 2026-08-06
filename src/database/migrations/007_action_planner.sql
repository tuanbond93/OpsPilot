-- OpsPilot Database Migration 007: Action Planner Schema (Upgrade-Safe)
-- Migration Version: 007
-- Created At: 2026-08-05

BEGIN;

-- 1. Create planner_runs table
CREATE TABLE IF NOT EXISTS planner_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    followup_case_id UUID NULL REFERENCES followup_cases(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED')),
    context_hash VARCHAR(64) NOT NULL,
    prompt_version INTEGER NOT NULL DEFAULT 1,
    provider VARCHAR(50) NOT NULL DEFAULT 'console',
    model VARCHAR(50) NOT NULL DEFAULT 'default',
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ NULL,
    reviewed_by VARCHAR(200) NULL
);

-- 2. Create planner_review_events table
CREATE TABLE IF NOT EXISTS planner_review_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    planner_run_id UUID NOT NULL REFERENCES planner_runs(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('CREATED', 'APPROVED', 'REJECTED', 'EXPIRED')),
    actor VARCHAR(200) NOT NULL,
    note TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_planner_runs_incident_id ON planner_runs(incident_id);
CREATE INDEX IF NOT EXISTS idx_planner_runs_status ON planner_runs(status);
CREATE INDEX IF NOT EXISTS idx_planner_runs_context_hash ON planner_runs(context_hash);
CREATE INDEX IF NOT EXISTS idx_planner_review_events_run_id ON planner_review_events(planner_run_id);

COMMIT;
