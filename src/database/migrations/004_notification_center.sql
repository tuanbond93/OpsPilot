-- OpsPilot Database Migration 004: Notification Center & Action Queue
-- Migration Version: 004
-- Created At: 2026-08-05

BEGIN;

CREATE TABLE IF NOT EXISTS notification_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type VARCHAR(50) NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'console',
    target_type VARCHAR(50) NOT NULL DEFAULT 'WAREHOUSE',
    target_id VARCHAR(100) NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    priority VARCHAR(20) NOT NULL DEFAULT 'medium',
    deduplication_key VARCHAR(255) NULL UNIQUE,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retry INTEGER NOT NULL DEFAULT 3,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    processed_at TIMESTAMPTZ NULL,
    last_error TEXT NULL,
    provider_response JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_actions_status ON notification_actions(status);
CREATE INDEX IF NOT EXISTS idx_notification_actions_dedup ON notification_actions(deduplication_key);
CREATE INDEX IF NOT EXISTS idx_notification_actions_scheduled ON notification_actions(scheduled_at);

COMMIT;
