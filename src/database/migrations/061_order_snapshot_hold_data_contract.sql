-- Additive nullable fields for the owner-verified Rillnet hold data contract.
-- Existing incident-selected snapshot population is intentionally unchanged.
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS weight_grams NUMERIC;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS weight_kg NUMERIC;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS destination_province_id TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS destination_district_id TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS deliver_warehouse_name TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS sort_code TEXT;
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS is_b2b BOOLEAN;
