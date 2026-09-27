-- Checkpoint Pipeline V2 fidelity repair.
-- customer_id is part of governed operational cohort identity. Keep the column
-- nullable for existing snapshots, and fail closed during V2 rehydration when
-- historical rows lack it; this avoids fabricating a business identity.
ALTER TABLE order_snapshots ADD COLUMN IF NOT EXISTS customer_id TEXT;

COMMENT ON COLUMN order_snapshots.customer_id IS
  'Source customer identity required for faithful Checkpoint Pipeline V2 cohort rehydration.';
