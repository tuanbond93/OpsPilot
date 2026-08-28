-- OpsPilot Database Migration 042: Notification Gateway Identity & RBAC
-- Extends the existing telegram_pilot_members with role and private chat support.
-- Adds scope-based authorization for fine-grained access control.

-- 1. Extend telegram_pilot_members for private chat and enhanced roles
ALTER TABLE telegram_pilot_members
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'EMPLOYEE'
    CHECK (role IN ('EMPLOYEE', 'LEAD', 'MANAGER', 'ADMIN'));

ALTER TABLE telegram_pilot_members
  ADD COLUMN IF NOT EXISTS private_chat_id BIGINT NULL;

ALTER TABLE telegram_pilot_members
  ADD COLUMN IF NOT EXISTS onboarding_state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (onboarding_state IN ('PRIVATE_READY', 'PRIVATE_NOT_STARTED', 'DISABLED', 'BLOCKED', 'UNKNOWN'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pilot_members_private_chat
  ON telegram_pilot_members(private_chat_id)
  WHERE private_chat_id IS NOT NULL;

-- 2. User scopes for RBAC
CREATE TABLE IF NOT EXISTS telegram_user_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('WAREHOUSE', 'PROVINCE', 'REGION', 'ALL')),
  scope_code TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'RECEIVE_NOTIFICATIONS'
    CHECK (permission IN ('RECEIVE_NOTIFICATIONS', 'VIEW_AUDIT', 'MANAGE_SCOPE', 'ADMIN')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by TEXT NULL,
  granted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(member_id, scope_type, scope_code)
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_scopes_member_active
  ON telegram_user_scopes(member_id, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_telegram_user_scopes_scope_lookup
  ON telegram_user_scopes(scope_type, scope_code, active)
  WHERE active = TRUE;

-- 3. Access requests (from /join flow)
CREATE TABLE IF NOT EXISTS telegram_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES telegram_pilot_members(id) ON DELETE RESTRICT,
  telegram_user_id BIGINT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  requested_scope_type TEXT NOT NULL CHECK (requested_scope_type IN ('WAREHOUSE', 'PROVINCE', 'REGION', 'ALL')),
  requested_scope_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  review_notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_access_requests_status
  ON telegram_access_requests(status, created_at DESC)
  WHERE status = 'PENDING';

-- Immutable audit for access request changes
CREATE TABLE IF NOT EXISTS telegram_access_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES telegram_access_requests(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('REQUEST_CREATED', 'REQUEST_APPROVED', 'REQUEST_REJECTED')),
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION reject_telegram_access_request_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'telegram_access_request_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS telegram_access_request_events_immutable ON telegram_access_request_events;
CREATE TRIGGER telegram_access_request_events_immutable
  BEFORE UPDATE OR DELETE ON telegram_access_request_events
  FOR EACH ROW EXECUTE FUNCTION reject_telegram_access_request_event_mutation();
