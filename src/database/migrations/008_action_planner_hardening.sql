-- OpsPilot Database Migration 008: Action Planner Hardening
-- Migration Version: 008
-- Created At: 2026-08-05

BEGIN;

-- 1. Safely update event_type CHECK constraint on planner_review_events to include 'REGENERATED'
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'planner_review_events_event_type_check'
    ) THEN
        ALTER TABLE planner_review_events DROP CONSTRAINT planner_review_events_event_type_check;
        ALTER TABLE planner_review_events ADD CONSTRAINT planner_review_events_event_type_check
        CHECK (event_type IN ('CREATED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REGENERATED'));
    END IF;
END $$;

-- 2. Add composite index / partial unique constraint to prevent concurrent duplicate planner runs
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_runs_inc_hash_ver_status
ON planner_runs (incident_id, context_hash, prompt_version, status);

COMMIT;
