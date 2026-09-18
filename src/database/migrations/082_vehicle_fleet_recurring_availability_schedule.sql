-- Migration 082: Vehicle Fleet Recurring Availability Schedule
-- Gate: Level C Gate 3D.2
-- Purpose:
--   1. Create public.vehicle_fleet_availability_schedules to govern recurring operating availability plans.
--   2. Enforce structural integrity: positive counts, daily time windows, effective date validity, actor provenance.
--   3. Secure with Row Level Security (RLS) strictly restricted to service_role.

-- 1. Create table
CREATE TABLE IF NOT EXISTS public.vehicle_fleet_availability_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  planned_available_count INTEGER NOT NULL,
  recurrence_type TEXT NOT NULL DEFAULT 'DAILY',
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  local_start_time TIME NOT NULL,
  local_end_time TIME NOT NULL,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE NULL,
  supplied_by TEXT NOT NULL,
  supplier_role TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  provenance_status TEXT NOT NULL DEFAULT 'OWNER_CONFIRMED_RECURRING_SCHEDULE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT chk_fleet_sched_warehouse_id CHECK (length(trim(warehouse_id)) > 0),
  CONSTRAINT chk_fleet_sched_supplier CHECK (length(trim(supplier_name)) > 0),
  CONSTRAINT chk_fleet_sched_class CHECK (length(trim(vehicle_class)) > 0),
  CONSTRAINT chk_fleet_sched_count CHECK (planned_available_count >= 0),
  CONSTRAINT chk_fleet_sched_recurrence CHECK (recurrence_type IN ('DAILY', 'WEEKLY')),
  CONSTRAINT chk_fleet_sched_time_window CHECK (local_start_time < local_end_time),
  CONSTRAINT chk_fleet_sched_effective_window CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CONSTRAINT chk_fleet_sched_source_ref CHECK (length(trim(source_ref)) > 0),
  CONSTRAINT chk_fleet_sched_actor CHECK (length(trim(supplied_by)) > 0 AND length(trim(supplier_role)) > 0),
  CONSTRAINT chk_fleet_sched_role CHECK (supplier_role IN ('WAREHOUSE_LEAD', 'OPERATIONS_MANAGER', 'DISPATCH_MANAGER', 'SYSTEM_ADMIN')),
  CONSTRAINT fk_fleet_sched_vehicle_class FOREIGN KEY (vehicle_class) REFERENCES public.governed_vehicle_classes(vehicle_class) ON DELETE RESTRICT
);

-- 2. Compound lookup index
CREATE INDEX IF NOT EXISTS idx_fleet_sched_lookup
  ON public.vehicle_fleet_availability_schedules (warehouse_id, vehicle_class, supplier_name, recurrence_type);

-- 3. Row Level Security (RLS)
ALTER TABLE public.vehicle_fleet_availability_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access on vehicle_fleet_availability_schedules" ON public.vehicle_fleet_availability_schedules;
CREATE POLICY "Allow service role full access on vehicle_fleet_availability_schedules"
  ON public.vehicle_fleet_availability_schedules FOR ALL TO service_role USING (true) WITH CHECK (true);
