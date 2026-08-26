-- LC-08: durable internal work orders. This migration never sends messages or executes operations.
CREATE TABLE IF NOT EXISTS execution_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE RESTRICT,
  work_order_code TEXT NOT NULL UNIQUE CHECK (work_order_code ~ '^OPSP-WO-[0-9]{8}-[A-Z0-9]{8}-01$'),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED')),
  owner TEXT NOT NULL CHECK (NULLIF(BTRIM(owner), '') IS NOT NULL),
  due_at TIMESTAMPTZ NOT NULL,
  action_items JSONB NOT NULL CHECK (jsonb_typeof(action_items) = 'array' AND jsonb_array_length(action_items) BETWEEN 1 AND 30),
  created_by TEXT NOT NULL CHECK (NULLIF(BTRIM(created_by), '') IS NOT NULL),
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status <> 'IN_PROGRESS') OR started_at IS NOT NULL),
  CHECK ((status <> 'COMPLETED') OR (started_at IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS execution_work_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES execution_work_orders(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_status TEXT NULL,
  new_status TEXT NOT NULL CHECK (new_status IN ('OPEN','IN_PROGRESS','COMPLETED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(work_order_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_execution_work_orders_status_due ON execution_work_orders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_execution_work_order_events_work_order_time ON execution_work_order_events(work_order_id, occurred_at);

CREATE OR REPLACE FUNCTION reject_execution_work_order_event_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'execution_work_order_events records are immutable' USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS execution_work_order_events_immutable ON execution_work_order_events;
CREATE TRIGGER execution_work_order_events_immutable BEFORE UPDATE OR DELETE ON execution_work_order_events
FOR EACH ROW EXECUTE FUNCTION reject_execution_work_order_event_mutation();
