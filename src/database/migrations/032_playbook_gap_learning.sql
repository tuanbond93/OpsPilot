-- LC-12: Human-reviewed playbook-gap learning.
-- Proposals are evidence-backed guidance for the AI planner only after manager approval.
-- They do not alter deterministic operational rules or dispatch any action.

CREATE TABLE IF NOT EXISTS playbook_gap_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  order_codes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(order_codes) = 'array' AND jsonb_array_length(order_codes) > 0),
  trigger_description TEXT NOT NULL CHECK (NULLIF(BTRIM(trigger_description), '') IS NOT NULL),
  responsible_owner TEXT NOT NULL CHECK (NULLIF(BTRIM(responsible_owner), '') IS NOT NULL),
  root_cause TEXT NOT NULL CHECK (NULLIF(BTRIM(root_cause), '') IS NOT NULL),
  standard_action TEXT NOT NULL CHECK (NULLIF(BTRIM(standard_action), '') IS NOT NULL),
  evidence TEXT NOT NULL CHECK (NULLIF(BTRIM(evidence), '') IS NOT NULL),
  submitted_by TEXT NOT NULL CHECK (NULLIF(BTRIM(submitted_by), '') IS NOT NULL),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playbook_gap_proposal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES playbook_gap_proposals(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
  actor TEXT NOT NULL CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  note TEXT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playbook_gap_proposals_incident ON playbook_gap_proposals(incident_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_gap_proposal_reviews_proposal ON playbook_gap_proposal_reviews(proposal_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_playbook_gap_proposal_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'playbook_gap_proposals records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS playbook_gap_proposals_immutable ON playbook_gap_proposals;
CREATE TRIGGER playbook_gap_proposals_immutable BEFORE UPDATE OR DELETE ON playbook_gap_proposals
FOR EACH ROW EXECUTE FUNCTION reject_playbook_gap_proposal_mutation();

CREATE OR REPLACE FUNCTION reject_playbook_gap_proposal_review_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'playbook_gap_proposal_reviews records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS playbook_gap_proposal_reviews_immutable ON playbook_gap_proposal_reviews;
CREATE TRIGGER playbook_gap_proposal_reviews_immutable BEFORE UPDATE OR DELETE ON playbook_gap_proposal_reviews
FOR EACH ROW EXECUTE FUNCTION reject_playbook_gap_proposal_review_mutation();
