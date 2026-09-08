-- Passive, append-only evidence for the five owner-approved lane pilots.
-- Collection starts after deployment; no historical backfill is performed.
CREATE TABLE IF NOT EXISTS lane_order_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id UUID NOT NULL REFERENCES sync_runs(id),
  order_code TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source_status TEXT NOT NULL,
  current_warehouse_id TEXT,
  current_warehouse_name TEXT,
  deliver_warehouse_id TEXT,
  deliver_warehouse_name TEXT,
  destination_province_id TEXT,
  destination_district_id TEXT,
  end_pick_at TIMESTAMPTZ,
  weight_kg NUMERIC,
  warehouse_log_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  pilot_lane_from_id TEXT NOT NULL,
  pilot_lane_to_id TEXT NOT NULL,
  current_warehouse_first_observed_at TIMESTAMPTZ NOT NULL,
  resolved_cut_off_receive TEXT,
  cot_resolution_status TEXT NOT NULL DEFAULT 'UNRESOLVED'
    CHECK (cot_resolution_status IN ('RESOLVED', 'UNRESOLVED', 'AMBIGUOUS')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lane_order_observation_sync_order UNIQUE (sync_run_id, order_code)
);

CREATE INDEX IF NOT EXISTS idx_lane_order_observations_order_time
  ON lane_order_observations (order_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_order_observations_lane_time
  ON lane_order_observations (pilot_lane_from_id, pilot_lane_to_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS lane_transition_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code TEXT NOT NULL,
  from_warehouse_id TEXT NOT NULL,
  from_warehouse_name TEXT,
  to_warehouse_id TEXT NOT NULL,
  to_warehouse_name TEXT,
  transition_window_start TIMESTAMPTZ NOT NULL,
  transition_window_end TIMESTAMPTZ NOT NULL,
  first_observed_at_from TIMESTAMPTZ NOT NULL,
  last_observed_at_from TIMESTAMPTZ NOT NULL,
  first_observed_at_to TIMESTAMPTZ NOT NULL,
  source_event_at TIMESTAMPTZ,
  receive_observed_at TIMESTAMPTZ,
  applicable_receive_cot TIMESTAMPTZ,
  cot_result TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (cot_result IN ('MET', 'MISSED', 'UNKNOWN')),
  source_observation_id UUID NOT NULL REFERENCES lane_order_observations(id),
  target_observation_id UUID NOT NULL REFERENCES lane_order_observations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lane_transition_observation_pair UNIQUE (source_observation_id, target_observation_id),
  CONSTRAINT ck_lane_transition_window CHECK (transition_window_end >= transition_window_start)
);

CREATE INDEX IF NOT EXISTS idx_lane_transition_observations_lane_time
  ON lane_transition_observations (from_warehouse_id, to_warehouse_id, transition_window_end DESC);

ALTER TABLE lane_order_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lane_transition_observations ENABLE ROW LEVEL SECURITY;
