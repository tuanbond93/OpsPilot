-- Script 080: Owner-Confirmed Vehicle Pilot Data (Master Data + Provisional Rate Evidence)
-- Gate: Level C Gate 3C.2D
-- Status: OPERATIONAL DATA INSERT SCRIPT (NOT A SCHEMA MIGRATION)
-- Execution: Manual execution by Operations Owner via Supabase SQL Editor after Migration 079.
-- Safety Invariant: Contains authoritative owner-confirmed facts without fabricated contract references.

-- 1. Insert Owner-Confirmed Vehicle Class: TRUCK_1_9T
INSERT INTO public.governed_vehicle_classes (
  vehicle_class,
  max_payload_kg,
  usable_payload_kg,
  volume_m3,
  effective_at,
  expires_at,
  source_ref,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  'TRUCK_1_9T',
  1900,
  1600,
  12,
  '2026-09-01T00:00:00+07:00',
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
) ON CONFLICT (vehicle_class) DO UPDATE SET
  max_payload_kg = EXCLUDED.max_payload_kg,
  usable_payload_kg = EXCLUDED.usable_payload_kg,
  volume_m3 = EXCLUDED.volume_m3,
  effective_at = EXCLUDED.effective_at,
  source_ref = EXCLUDED.source_ref,
  provenance_status = EXCLUDED.provenance_status,
  updated_at = NOW();

-- 2. Insert 5 Owner-Confirmed Monthly Vehicle Rates
-- Contract references remain NULL until formal legal contracts are attached.
-- Source ref records authoritative owner confirmation timestamp.

-- Rate 1: Phú Thọ (21160000) — Supplier: Thiên Phú (33,551,605 VND / MONTH)
INSERT INTO public.governed_vehicle_rates (
  warehouse_id,
  vehicle_class,
  route_or_area,
  rate_vnd,
  rate_basis,
  effective_at,
  expires_at,
  contract_ref,
  source_ref,
  supplier_name,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  '21160000',
  'TRUCK_1_9T',
  NULL,
  33551605,
  'MONTH',
  '2026-09-01T00:00:00+07:00',
  NULL,
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'Thiên Phú',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
);

-- Rate 2: Phú Thọ (21160000) — Supplier: Hoàng Minh (35,663,481 VND / MONTH)
INSERT INTO public.governed_vehicle_rates (
  warehouse_id,
  vehicle_class,
  route_or_area,
  rate_vnd,
  rate_basis,
  effective_at,
  expires_at,
  contract_ref,
  source_ref,
  supplier_name,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  '21160000',
  'TRUCK_1_9T',
  NULL,
  35663481,
  'MONTH',
  '2026-09-01T00:00:00+07:00',
  NULL,
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'Hoàng Minh',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
);

-- Rate 3: Lào Cai (21158000) — Supplier: Hoàng Minh (38,041,046 VND / MONTH)
INSERT INTO public.governed_vehicle_rates (
  warehouse_id,
  vehicle_class,
  route_or_area,
  rate_vnd,
  rate_basis,
  effective_at,
  expires_at,
  contract_ref,
  source_ref,
  supplier_name,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  '21158000',
  'TRUCK_1_9T',
  NULL,
  38041046,
  'MONTH',
  '2026-09-01T00:00:00+07:00',
  NULL,
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'Hoàng Minh',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
);

-- Rate 4: Lào Cai (21158000) — Supplier: Thuận Phát (36,528,734 VND / MONTH)
INSERT INTO public.governed_vehicle_rates (
  warehouse_id,
  vehicle_class,
  route_or_area,
  rate_vnd,
  rate_basis,
  effective_at,
  expires_at,
  contract_ref,
  source_ref,
  supplier_name,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  '21158000',
  'TRUCK_1_9T',
  NULL,
  36528734,
  'MONTH',
  '2026-09-01T00:00:00+07:00',
  NULL,
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'Thuận Phát',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
);

-- Rate 5: Yên Bái (21161000) — Supplier: Hoàng Minh (36,852,263 VND / MONTH)
INSERT INTO public.governed_vehicle_rates (
  warehouse_id,
  vehicle_class,
  route_or_area,
  rate_vnd,
  rate_basis,
  effective_at,
  expires_at,
  contract_ref,
  source_ref,
  supplier_name,
  provenance_status,
  created_at,
  updated_at
) VALUES (
  '21161000',
  'TRUCK_1_9T',
  NULL,
  36852263,
  'MONTH',
  '2026-09-01T00:00:00+07:00',
  NULL,
  NULL,
  'OWNER_CONFIRMED:OPS_OWNER:2026-09-18',
  'Hoàng Minh',
  'OWNER_CONFIRMED_PENDING_DOCUMENT',
  NOW(),
  NOW()
);
