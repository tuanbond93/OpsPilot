-- Allow the normal Phase 2 checkpoint to recover a case whose fact request
-- failed before FACT_REQUEST_SENT was persisted. The claim is a short lease;
-- a crashed worker therefore remains recoverable on a later checkpoint.
ALTER TABLE near_term_capacity_cases
  ADD COLUMN IF NOT EXISTS fact_request_delivery_claimed_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS one_fact_request_sent_event_per_case
  ON near_term_capacity_events(case_id) WHERE event_type = 'FACT_REQUEST_SENT';
