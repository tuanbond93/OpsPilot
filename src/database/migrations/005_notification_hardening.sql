-- OpsPilot Database Migration 005: Notification Center Hardening (Upgrade-Safe)
-- Migration Version: 005
-- Created At: 2026-08-05

BEGIN;

-- 1. Safely add locking columns to notification_actions
ALTER TABLE notification_actions ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE notification_actions ADD COLUMN IF NOT EXISTS locked_by VARCHAR(100);
ALTER TABLE notification_actions ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ;
ALTER TABLE notification_actions ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);
ALTER TABLE notification_actions ADD COLUMN IF NOT EXISTS outcome VARCHAR(30);

-- 2. Create immutable audit events table
CREATE TABLE IF NOT EXISTS notification_action_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id UUID NOT NULL REFERENCES notification_actions(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    old_status VARCHAR(30) NULL,
    new_status VARCHAR(30) NULL,
    attempt_number INTEGER NOT NULL DEFAULT 0,
    provider VARCHAR(50) NULL,
    provider_message_id VARCHAR(255) NULL,
    error_code VARCHAR(100) NULL,
    error_message TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes for high-performance claim queries and timeline audit lookups
CREATE INDEX IF NOT EXISTS idx_notification_actions_status_sched_prio ON notification_actions(status, scheduled_at, priority);
CREATE INDEX IF NOT EXISTS idx_notification_actions_provider ON notification_actions(provider);
CREATE INDEX IF NOT EXISTS idx_notification_actions_target ON notification_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notification_actions_created ON notification_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_action_events_action_created ON notification_action_events(action_id, created_at);

COMMIT;
