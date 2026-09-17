-- Migration 077: Per-warehouse active case concurrency constraint
-- Replaces global active case uniqueness with per-warehouse active uniqueness.
-- Safe migration: verified in production that exactly 1 active case exists.

DROP INDEX IF EXISTS one_active_near_term_capacity_case;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_near_term_capacity_case_per_warehouse
  ON near_term_capacity_cases (warehouse_id)
  WHERE active = true;

-- Rollback SQL:
-- DROP INDEX IF EXISTS one_active_near_term_capacity_case_per_warehouse;
-- CREATE UNIQUE INDEX IF NOT EXISTS one_active_near_term_capacity_case
--   ON near_term_capacity_cases ((active))
--   WHERE active;
