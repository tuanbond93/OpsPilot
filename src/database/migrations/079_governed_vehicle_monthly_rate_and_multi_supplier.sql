-- Migration 079: Governed Vehicle Monthly Rate & Multi-Supplier Schema Patch
-- Gate: Level C Gate 3C.2D (Finalized)
-- Purpose:
--   1. Expand rate_basis constraint on governed_vehicle_rates to support 'MONTH' (in addition to 'TRIP', 'DAY', 'HOUR', 'KG')
--   2. Introduce explicit provenance_status to distinguish OWNER_CONFIRMED_PENDING_DOCUMENT from DOCUMENT_VERIFIED
--   3. Allow contract_ref to be NULL ONLY when provenance_status = 'OWNER_CONFIRMED_PENDING_DOCUMENT'
--   4. Strictly enforce contract_ref when provenance_status = 'DOCUMENT_VERIFIED'
--   5. Ensure source_ref is always strictly mandatory
--   6. Update uniqueness index uq_governed_rate_active_scope so multiple governed suppliers/contracts
--      can coexist for the same warehouse and vehicle class without duplicate active records.
--
-- Safety & Governance Invariants:
--   - Read-only runtime: No operational owner data is seeded or inserted by this migration (RATES_INSERTED: NO, VEHICLE_CLASS_INSERTED: NO).
--   - Governed monthly rates must be stored with rate_basis = 'MONTH' without implicit division by 30.
--   - Safe for manual execution after Migration 078.

-- 1. Expand rate_basis check constraint to support 'MONTH'
ALTER TABLE public.governed_vehicle_rates
  DROP CONSTRAINT IF EXISTS chk_vehicle_rate_basis;

ALTER TABLE public.governed_vehicle_rates
  ADD CONSTRAINT chk_vehicle_rate_basis
  CHECK (rate_basis IN ('TRIP', 'DAY', 'HOUR', 'KG', 'MONTH'));

-- 2. Add provenance_status to governed_vehicle_classes
ALTER TABLE public.governed_vehicle_classes
  ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'DOCUMENT_VERIFIED';

ALTER TABLE public.governed_vehicle_classes
  DROP CONSTRAINT IF EXISTS chk_vehicle_class_provenance;

ALTER TABLE public.governed_vehicle_classes
  ADD CONSTRAINT chk_vehicle_class_provenance
  CHECK (provenance_status IN ('OWNER_CONFIRMED_PENDING_DOCUMENT', 'DOCUMENT_VERIFIED'));

-- 3. Add provenance_status to governed_vehicle_rates
ALTER TABLE public.governed_vehicle_rates
  ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'DOCUMENT_VERIFIED';

ALTER TABLE public.governed_vehicle_rates
  DROP CONSTRAINT IF EXISTS chk_vehicle_rate_provenance;

ALTER TABLE public.governed_vehicle_rates
  ADD CONSTRAINT chk_vehicle_rate_provenance
  CHECK (provenance_status IN ('OWNER_CONFIRMED_PENDING_DOCUMENT', 'DOCUMENT_VERIFIED'));

-- 4. Make contract_ref nullable on governed_vehicle_rates, strictly governed by provenance_status
ALTER TABLE public.governed_vehicle_rates
  ALTER COLUMN contract_ref DROP NOT NULL;

ALTER TABLE public.governed_vehicle_rates
  DROP CONSTRAINT IF EXISTS chk_vehicle_rate_contract_ref;

ALTER TABLE public.governed_vehicle_rates
  DROP CONSTRAINT IF EXISTS chk_vehicle_rate_contract_provenance;

ALTER TABLE public.governed_vehicle_rates
  ADD CONSTRAINT chk_vehicle_rate_contract_provenance
  CHECK (
    (provenance_status = 'DOCUMENT_VERIFIED' AND contract_ref IS NOT NULL AND length(trim(contract_ref)) > 0)
    OR
    (provenance_status = 'OWNER_CONFIRMED_PENDING_DOCUMENT' AND (contract_ref IS NULL OR length(trim(contract_ref)) > 0))
  );

-- 5. Recreate active rate scope uniqueness index to support multi-supplier coexistence and nullable contract_ref
DROP INDEX IF EXISTS public.uq_governed_rate_active_scope;

CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_rate_active_scope
  ON public.governed_vehicle_rates (
    warehouse_id,
    vehicle_class,
    COALESCE(route_or_area, 'GLOBAL'),
    COALESCE(supplier_name, 'UNSPECIFIED'),
    COALESCE(contract_ref, 'PENDING_DOCUMENT')
  )
  WHERE expires_at IS NULL;
