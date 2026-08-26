-- OpsPilot Database Migration 016: Copilot Runs & Human Review Schema
-- Migration Version: 016
-- Created At: 2026-08-07

BEGIN;

-- 1. Create copilot_runs table
CREATE TABLE IF NOT EXISTS copilot_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL,
    prompt_id VARCHAR(100) NOT NULL DEFAULT 'copilot',
    prompt_version VARCHAR(50) NOT NULL DEFAULT 'v1',
    provider VARCHAR(50) NULL,
    model VARCHAR(100) NULL,
    copilot_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create copilot_reviews table
CREATE TABLE IF NOT EXISTS copilot_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES copilot_runs(id) ON DELETE CASCADE,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL,
    status VARCHAR(30) NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'EDITED', 'REJECTED', 'SUPERSEDED')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    reviewed_by VARCHAR(200) NULL,
    rating INTEGER NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NULL,
    edited_result JSONB NULL,
    prompt_id VARCHAR(100) NOT NULL,
    prompt_version VARCHAR(50) NOT NULL,
    provider VARCHAR(50) NULL,
    model VARCHAR(100) NULL,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes & Constraints
CREATE INDEX IF NOT EXISTS idx_copilot_runs_incident_id ON copilot_runs(incident_id);
CREATE INDEX IF NOT EXISTS idx_copilot_runs_workflow_id ON copilot_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_copilot_runs_created_at ON copilot_runs(created_at);

CREATE INDEX IF NOT EXISTS idx_copilot_reviews_run_id ON copilot_reviews(run_id);
CREATE INDEX IF NOT EXISTS idx_copilot_reviews_incident_id ON copilot_reviews(incident_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_copilot_reviews_active ON copilot_reviews(run_id) WHERE is_active = TRUE;

COMMIT;
