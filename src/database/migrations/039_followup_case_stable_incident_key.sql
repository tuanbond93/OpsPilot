-- Follow-up ownership must survive a source incident row being rebuilt on a
-- later sync.  incident_key is the deterministic business identity; the UUID
-- incident_id is only the current source-row reference.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'followup_cases_incident_key_unique'
      AND conrelid = 'followup_cases'::regclass
  ) THEN
    ALTER TABLE followup_cases
      ADD CONSTRAINT followup_cases_incident_key_unique UNIQUE (incident_key);
  END IF;
END $$;

-- Repair existing cases immediately.  This keeps their audit/event history
-- while moving the source-row reference to the currently open/resolved
-- incident that has the same stable business key.
UPDATE followup_cases AS followup
SET incident_id = incident.id,
    updated_at = NOW()
FROM incidents AS incident
WHERE incident.incident_key = followup.incident_key
  AND followup.incident_id IS DISTINCT FROM incident.id;
