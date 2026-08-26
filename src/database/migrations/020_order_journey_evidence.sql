-- Additive, nullable journey evidence. No existing P&L/Decision data is changed.
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS pick_warehouse_id TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS deliver_warehouse_id TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS service_type_id TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS end_pick_at TIMESTAMPTZ;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS end_delivery_at TIMESTAMPTZ;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS end_success_at TIMESTAMPTZ;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS warehouse_log JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS pickup_journey_coverage_percent NUMERIC;
ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS pickup_delayed_order_count INTEGER;
ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS maximum_pickup_wait_hours NUMERIC;
ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS pickup_delay_order_codes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_order_snapshots_end_pick_at ON order_snapshots(end_pick_at) WHERE end_pick_at IS NOT NULL;
