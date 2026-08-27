-- TG-01.1: one Telegram member may cover more than one warehouse.
-- Keep warehouse_name as a legacy primary/default owner for compatibility.

ALTER TABLE telegram_pilot_members
  ADD COLUMN IF NOT EXISTS warehouse_names JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(warehouse_names) = 'array' AND jsonb_array_length(warehouse_names) <= 30);

UPDATE telegram_pilot_members
SET warehouse_names = jsonb_build_array(warehouse_name)
WHERE warehouse_name IS NOT NULL
  AND jsonb_array_length(warehouse_names) = 0;
