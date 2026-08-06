-- OpsPilot Database Migration 006: CHECK Constraints for Notification Center (Upgrade-Safe)
-- Migration Version: 006
-- Created At: 2026-08-05
-- Purpose: Add CHECK constraints to enforce valid enum values at the database level.
-- Safe to run on fresh or existing databases.

BEGIN;

-- 1. notification_actions.status CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_actions_status'
    ) THEN
        ALTER TABLE notification_actions
        ADD CONSTRAINT chk_notification_actions_status
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'SIMULATED', 'FAILED', 'CANCELLED', 'EXPIRED'));
    END IF;
END $$;

-- 2. notification_actions.outcome CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_actions_outcome'
    ) THEN
        ALTER TABLE notification_actions
        ADD CONSTRAINT chk_notification_actions_outcome
        CHECK (outcome IS NULL OR outcome IN ('DELIVERED', 'SIMULATED', 'FAILED'));
    END IF;
END $$;

-- 3. notification_actions.action_type CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_actions_action_type'
    ) THEN
        ALTER TABLE notification_actions
        ADD CONSTRAINT chk_notification_actions_action_type
        CHECK (action_type IN ('FIRST_PUSH', 'SECOND_PUSH', 'ESCALATION', 'ROOTCAUSE_SUMMARY', 'DAILY_REPORT', 'WARNING', 'SYSTEM', 'CUSTOM'));
    END IF;
END $$;

-- 4. notification_actions.target_type CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_actions_target_type'
    ) THEN
        ALTER TABLE notification_actions
        ADD CONSTRAINT chk_notification_actions_target_type
        CHECK (target_type IN ('WAREHOUSE', 'LEAD', 'MANAGER', 'EXECUTIVE', 'SYSTEM'));
    END IF;
END $$;

-- 5. notification_actions.priority CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_actions_priority'
    ) THEN
        ALTER TABLE notification_actions
        ADD CONSTRAINT chk_notification_actions_priority
        CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
    END IF;
END $$;

-- 6. notification_action_events.event_type CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'chk_notification_action_events_event_type'
    ) THEN
        ALTER TABLE notification_action_events
        ADD CONSTRAINT chk_notification_action_events_event_type
        CHECK (event_type IN (
            'ACTION_ENQUEUED', 'ACTION_DEDUPLICATED', 'ACTION_CLAIMED',
            'DELIVERY_SUCCEEDED', 'DELIVERY_SIMULATED', 'DELIVERY_FAILED',
            'RETRY_SCHEDULED', 'ACTION_CANCELLED', 'ACTION_EXPIRED',
            'PROCESSING_RECOVERED', 'MANUAL_CONFIRMED'
        ));
    END IF;
END $$;

COMMIT;
