-- OpsPilot Database Migration 010: AI Analysis Queue Schema (Upgrade-Safe)
-- Migration Version: 010
-- Created At: 2026-08-05

BEGIN;

-- 1. Create ai_analysis_jobs table
CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    locked_at TIMESTAMPTZ NULL,
    worker_id VARCHAR(100) NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create indexes for efficient queue polling and lookups
CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_status_sched ON ai_analysis_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_incident_id ON ai_analysis_jobs(incident_id);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_priority ON ai_analysis_jobs(priority);

COMMIT;
