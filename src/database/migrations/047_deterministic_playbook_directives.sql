-- LC-C1: the only source of deterministic DO/DONT policy conflicts.
-- Rillnet observations and AI outputs must never be inserted here automatically.
CREATE TABLE IF NOT EXISTS decision_playbook_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version TEXT NOT NULL CHECK (NULLIF(BTRIM(policy_version), '') IS NOT NULL),
  reason_code TEXT NOT NULL CHECK (NULLIF(BTRIM(reason_code), '') IS NOT NULL),
  followup_state TEXT NULL,
  warehouse_id TEXT NULL,
  zone_name TEXT NULL,
  action_code TEXT NOT NULL CHECK (NULLIF(BTRIM(action_code), '') IS NOT NULL),
  polarity TEXT NOT NULL CHECK (polarity IN ('DO', 'DONT')),
  priority INTEGER NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT true,
  approved_by TEXT NOT NULL CHECK (NULLIF(BTRIM(approved_by), '') IS NOT NULL),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (warehouse_id IS NULL OR NULLIF(BTRIM(warehouse_id), '') IS NOT NULL),
  CHECK (zone_name IS NULL OR NULLIF(BTRIM(zone_name), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_decision_playbook_directives_match
  ON decision_playbook_directives (reason_code, active, warehouse_id, zone_name, followup_state, priority DESC);

COMMENT ON TABLE decision_playbook_directives IS
  'Human-approved deterministic policy directives only; empty by default so no operational policy is invented.';
