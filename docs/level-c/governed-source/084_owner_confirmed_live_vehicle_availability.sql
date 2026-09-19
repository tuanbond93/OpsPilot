-- Governed Source Data Script: First Real Live Vehicle Availability Facts (Gate 3D.4)
-- Gate: Level C Gate 3D.4
-- Purpose:
--   Persist first real operational manager confirmation of vehicle availability into public.vehicle_fleet_availability.
--   Timezone: Asia/Ho_Chi_Minh
--   Vehicle class: TRUCK_1_9T (1,600 kg usable payload)
--   Source: OPERATIONS_MANAGER_DIRECT_CONFIRMATION
--   Confirmation time: Actual write time (2026-09-19 11:13:40 ICT)
--   Earliest availability: 2026-09-19 07:00:00 ICT
-- NOTE: Do NOT backdate confirmation time to 07:00.
-- NOTE: Negative control (Lào Cai / Hoàng Minh) is strictly excluded (NO ROW).

INSERT INTO public.vehicle_fleet_availability (
  warehouse_id,
  supplier_name,
  vehicle_class,
  available,
  available_count,
  available_at,
  captured_at,
  valid_until,
  source_ref,
  supplied_by,
  supplier_role
) VALUES
  -- 1. Yên Bái (21161000) — Hoàng Minh (1 xe 1.9T, valid until 12:00 ICT)
  (
    '21161000',
    'Hoàng Minh',
    'TRUCK_1_9T',
    true,
    1,
    '2026-09-19T07:00:00+07:00',
    '2026-09-19T11:13:40+07:00',
    '2026-09-19T12:00:00+07:00',
    'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19',
    'OPS_OWNER',
    'OPERATIONS_MANAGER'
  ),

  -- 2. Lào Cai (21158000) — Thuận Phát (1 xe 1.9T, valid until 12:00 ICT)
  (
    '21158000',
    'Thuận Phát',
    'TRUCK_1_9T',
    true,
    1,
    '2026-09-19T07:00:00+07:00',
    '2026-09-19T11:13:40+07:00',
    '2026-09-19T12:00:00+07:00',
    'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19',
    'OPS_OWNER',
    'OPERATIONS_MANAGER'
  ),

  -- 3. Phú Thọ (21160000) — Thiên Phú (2 xe 1.9T, valid until 14:00 ICT)
  (
    '21160000',
    'Thiên Phú',
    'TRUCK_1_9T',
    true,
    2,
    '2026-09-19T07:00:00+07:00',
    '2026-09-19T11:13:40+07:00',
    '2026-09-19T14:00:00+07:00',
    'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19',
    'OPS_OWNER',
    'OPERATIONS_MANAGER'
  ),

  -- 4. Phú Thọ (21160000) — Hoàng Minh (2 xe 1.9T, valid until 14:00 ICT)
  (
    '21160000',
    'Hoàng Minh',
    'TRUCK_1_9T',
    true,
    2,
    '2026-09-19T07:00:00+07:00',
    '2026-09-19T11:13:40+07:00',
    '2026-09-19T14:00:00+07:00',
    'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19',
    'OPS_OWNER',
    'OPERATIONS_MANAGER'
  );
