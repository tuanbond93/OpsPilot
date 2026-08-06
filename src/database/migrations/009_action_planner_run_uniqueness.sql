-- OpsPilot Database Migration 009: Action Planner Run Uniqueness (Partial Index for Active DRAFT Runs)
-- Migration Version: 009
-- Created At: 2026-08-05

BEGIN;

-- 1. Drop previous full composite index if exists
DROP INDEX IF EXISTS uq_planner_runs_inc_hash_ver_status;

-- 2. Create partial unique index ONLY for active DRAFT runs
-- Allows historical APPROVED, REJECTED, and EXPIRED runs to exist without conflict
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_runs_active_draft
ON planner_runs (incident_id, context_hash, prompt_version)
WHERE status = 'DRAFT';

COMMIT;
