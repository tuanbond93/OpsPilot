-- Telegram roster can be assigned to a whole operational zone, while keeping
-- explicit warehouse mappings for exceptions and backward compatibility.
ALTER TABLE telegram_pilot_members
  ADD COLUMN IF NOT EXISTS zone_names JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(zone_names) = 'array' AND jsonb_array_length(zone_names) <= 20);

COMMENT ON COLUMN telegram_pilot_members.zone_names IS
  'Operational zones assigned to the Telegram member. Eligible for work orders whose owner warehouse belongs to any listed zone.';
