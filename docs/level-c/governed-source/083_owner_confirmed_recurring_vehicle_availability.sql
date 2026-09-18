-- Governed Source Data Script: Owner-Confirmed Recurring Vehicle Availability Schedules
-- Gate: Level C Gate 3D.2
-- Purpose:
--   Seed owner-confirmed recurring operating availability plans into public.vehicle_fleet_availability_schedules.
--   Timezone: Asia/Ho_Chi_Minh
--   Daily window: 07:00 inclusive to 10:00 exclusive
--   Effective from: 2026-09-19
-- NOTE: Do NOT execute automatically. Apply manually via Supabase SQL Editor when authorized.

INSERT INTO public.vehicle_fleet_availability_schedules (
  warehouse_id,
  supplier_name,
  vehicle_class,
  planned_available_count,
  recurrence_type,
  timezone,
  local_start_time,
  local_end_time,
  effective_from,
  effective_until,
  supplied_by,
  supplier_role,
  source_ref,
  provenance_status
) VALUES
  -- 1. Kho Yên Bái - Hoàng Minh (1 xe 1.9T)
  (
    '21161000',
    'Hoàng Minh',
    'TRUCK_1_9T',
    1,
    'DAILY',
    'Asia/Ho_Chi_Minh',
    '07:00',
    '10:00',
    '2026-09-19',
    NULL,
    'OPS_OWNER',
    'OPERATIONS_MANAGER',
    'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
    'OWNER_CONFIRMED_RECURRING_SCHEDULE'
  ),

  -- 2. Kho Lào Cai - Thuận Phát (2 xe 1.9T)
  (
    '21158000',
    'Thuận Phát',
    'TRUCK_1_9T',
    2,
    'DAILY',
    'Asia/Ho_Chi_Minh',
    '07:00',
    '10:00',
    '2026-09-19',
    NULL,
    'OPS_OWNER',
    'OPERATIONS_MANAGER',
    'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
    'OWNER_CONFIRMED_RECURRING_SCHEDULE'
  ),

  -- 3. Kho Phú Thọ - Thiên Phú (5 xe 1.9T)
  (
    '21160000',
    'Thiên Phú',
    'TRUCK_1_9T',
    5,
    'DAILY',
    'Asia/Ho_Chi_Minh',
    '07:00',
    '10:00',
    '2026-09-19',
    NULL,
    'OPS_OWNER',
    'OPERATIONS_MANAGER',
    'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
    'OWNER_CONFIRMED_RECURRING_SCHEDULE'
  ),

  -- 4. Kho Phú Thọ - Hoàng Minh (5 xe 1.9T)
  (
    '21160000',
    'Hoàng Minh',
    'TRUCK_1_9T',
    5,
    'DAILY',
    'Asia/Ho_Chi_Minh',
    '07:00',
    '10:00',
    '2026-09-19',
    NULL,
    'OPS_OWNER',
    'OPERATIONS_MANAGER',
    'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
    'OWNER_CONFIRMED_RECURRING_SCHEDULE'
  );
