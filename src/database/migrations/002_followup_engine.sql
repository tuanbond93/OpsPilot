-- OpsPilot Database Migration 002: Follow-up Engine & Operational State Machine
-- Migration Version: 002
-- Created At: 2026-08-05

CREATE TYPE followup_state_enum AS ENUM (
    'NEW',
    'FIRST_PUSH_SENT',
    'FOLLOWING_UP',
    'SECOND_PUSH_SENT',
    'ESCALATED',
    'RESOLVED',
    'CLOSED'
);

CREATE TYPE progress_assessment_enum AS ENUM (
    'strong_progress',
    'limited_progress',
    'no_progress',
    'worsening',
    'insufficient_data'
);

-- Table: followup_cases
CREATE TABLE IF NOT EXISTS followup_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id TEXT NOT NULL UNIQUE, -- Stable incident_key / DB UUID
    current_state followup_state_enum NOT NULL DEFAULT 'NEW',
    first_detected_at TIMESTAMPTZ NOT NULL,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ NULL,
    closed_at TIMESTAMPTZ NULL,
    current_progress_percent NUMERIC(5,2) DEFAULT 0,
    current_assessment progress_assessment_enum NOT NULL DEFAULT 'insufficient_data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: followup_events
CREATE TABLE IF NOT EXISTS followup_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    followup_case_id UUID NOT NULL REFERENCES followup_cases(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot_id UUID NULL,
    old_state followup_state_enum NOT NULL,
    new_state followup_state_enum NOT NULL,
    assessment progress_assessment_enum NOT NULL,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_followup_cases_incident_id ON followup_cases(incident_id);
CREATE INDEX IF NOT EXISTS idx_followup_cases_current_state ON followup_cases(current_state);
CREATE INDEX IF NOT EXISTS idx_followup_events_case_id ON followup_events(followup_case_id);
