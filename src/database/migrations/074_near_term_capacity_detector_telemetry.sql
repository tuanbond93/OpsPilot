CREATE TABLE IF NOT EXISTS public.near_term_capacity_checkpoint_telemetry (
  checkpoint_at TIMESTAMPTZ NOT NULL,
  sync_run_id UUID NOT NULL,
  incidents_available INTEGER NOT NULL DEFAULT 0,
  incidents_scanned INTEGER NOT NULL DEFAULT 0,
  candidates_detected INTEGER NOT NULL DEFAULT 0,
  candidates_persisted INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  missing_signal_count INTEGER NOT NULL DEFAULT 0,
  no_risk_count INTEGER NOT NULL DEFAULT 0,
  below_threshold_count INTEGER NOT NULL DEFAULT 0,
  outside_scope_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  active_case_block_count INTEGER NOT NULL DEFAULT 0,
  other_rejection_count INTEGER NOT NULL DEFAULT 0,
  phase2_started_at TIMESTAMPTZ NOT NULL,
  phase2_completed_at TIMESTAMPTZ NOT NULL,
  phase2_duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (checkpoint_at, sync_run_id)
);

CREATE TABLE IF NOT EXISTS public.near_term_capacity_detector_telemetry (
  checkpoint_at TIMESTAMPTZ NOT NULL,
  sync_run_id UUID NOT NULL,
  incident_key TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  warehouse TEXT NOT NULL,
  province TEXT,
  affected_order_count INTEGER,
  current_kg NUMERIC,
  captured_at_present BOOLEAN NOT NULL,
  evidence_refs_present BOOLEAN NOT NULL,
  risk_signals_present BOOLEAN NOT NULL,
  current_orders_availability TEXT NOT NULL,
  current_kg_availability TEXT NOT NULL,
  backlog_trend_availability TEXT NOT NULL,
  new_inflow_availability TEXT NOT NULL,
  vehicle_capacity_availability TEXT NOT NULL,
  manpower_capacity_availability TEXT NOT NULL,
  cot_deadline_availability TEXT NOT NULL,
  detector_result TEXT NOT NULL,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (checkpoint_at, sync_run_id, incident_key)
);

ALTER TABLE public.near_term_capacity_checkpoint_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.near_term_capacity_detector_telemetry ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_near_term_capacity_checkpoint_telemetry_sync
  ON public.near_term_capacity_checkpoint_telemetry (sync_run_id, checkpoint_at);
CREATE INDEX IF NOT EXISTS idx_near_term_capacity_detector_telemetry_result
  ON public.near_term_capacity_detector_telemetry (checkpoint_at, sync_run_id, detector_result, rejection_reason);
CREATE INDEX IF NOT EXISTS idx_near_term_capacity_detector_telemetry_incident
  ON public.near_term_capacity_detector_telemetry (incident_key);
