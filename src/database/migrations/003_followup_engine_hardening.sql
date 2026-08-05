-- OpsPilot Database Migration 003: Follow-up Engine Hardening (Upgrade-Safe)
-- Migration Version: 003
-- Created At: 2026-08-05

BEGIN;

-- 1. Safely add new states to followup_state_enum if not already present
ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'FIRST_PUSH_PENDING';
ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'SECOND_PUSH_PENDING';
ALTER TYPE followup_state_enum ADD VALUE IF NOT EXISTS 'ESCALATION_PENDING';

-- 2. Safely add new columns to followup_cases if not already present
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS incident_key TEXT;
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS baseline_affected_order_count INTEGER DEFAULT 0;
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS latest_affected_order_count INTEGER DEFAULT 0;
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS last_action_requested_at TIMESTAMPTZ;
ALTER TABLE followup_cases ADD COLUMN IF NOT EXISTS last_action_confirmed_at TIMESTAMPTZ;

-- 3. Populate incident_key from incident_id if incident_key is null
UPDATE followup_cases SET incident_key = incident_id WHERE incident_key IS NULL;

-- 4. Add index on incident_key
CREATE INDEX IF NOT EXISTS idx_followup_cases_incident_key ON followup_cases(incident_key);

-- 5. Safely alter incident_id to UUID with FK referencing incidents(id) if valid
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='followup_cases' AND column_name='incident_id' AND data_type='text'
    ) THEN
        -- Convert valid text UUIDs to UUID type
        ALTER TABLE followup_cases 
        ALTER COLUMN incident_id TYPE UUID USING (
            CASE WHEN incident_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                 THEN incident_id::UUID 
                 ELSE NULL 
            END
        );
    END IF;
END $$;

-- 6. Add Foreign Key constraint if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name='fk_followup_cases_incident' AND table_name='followup_cases'
    ) THEN
        ALTER TABLE followup_cases 
        ADD CONSTRAINT fk_followup_cases_incident 
        FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 7. Safely add confirmed_by to followup_events
ALTER TABLE followup_events ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(100);

COMMIT;
