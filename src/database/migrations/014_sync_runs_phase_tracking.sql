-- OpsPilot Database Migration 014: Add phase tracking to sync_runs for resumption & recovery
-- Migration Version: 014
-- Created At: 2026-08-06

ALTER TABLE sync_runs
    ADD COLUMN IF NOT EXISTS current_phase TEXT NULL,
    ADD COLUMN IF NOT EXISTS completed_phases JSONB NOT NULL DEFAULT '[]'::jsonb;
