-- OpsPilot Database Migration 013: Expand followup_cases.current_progress_percent precision
-- Migration Version: 013
-- Created At: 2026-08-06

-- Expand NUMERIC(5,2) to NUMERIC(10,2) to safely accommodate large percentage changes (e.g. -19900.00% or -999900.00%) without numeric field overflow.
ALTER TABLE followup_cases
    ALTER COLUMN current_progress_percent TYPE NUMERIC(10,2);
