-- Snapshot Retention V2.1 read-only audit.
-- Run in the Supabase SQL editor only. Every statement is SELECT-only.
-- Time zone is Asia/Ho_Chi_Minh. "Full days" excludes the current local day.

-- C) Schema/business-key truth: order_code is the canonical order identifier.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'order_snapshots'
ORDER BY ordinal_position;

-- D) Per-day volume for the last 14 completed local days.
WITH bounds AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AS today_local
), daily_order_counts AS (
  SELECT
    date_trunc('day', os.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS snapshot_date,
    os.order_code,
    count(*)::bigint AS snapshot_count
  FROM public.order_snapshots os
  CROSS JOIN bounds b
  WHERE os.created_at >= ((b.today_local - interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')
    AND os.created_at < (b.today_local AT TIME ZONE 'Asia/Ho_Chi_Minh')
  GROUP BY 1, 2
), daily AS (
  SELECT snapshot_date, sum(snapshot_count)::bigint AS snapshot_rows,
         count(*)::bigint AS unique_orders,
         avg(snapshot_count)::numeric AS snapshots_per_order_avg,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY snapshot_count) AS snapshots_per_order_median,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY snapshot_count) AS snapshots_per_order_p95,
         max(snapshot_count)::bigint AS max_snapshots_per_order
  FROM daily_order_counts
  GROUP BY snapshot_date
)
SELECT * FROM daily ORDER BY snapshot_date;

-- D) Rolling 7-day and 14-day totals.
WITH bounds AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AS today_local
)
SELECT
  count(*) FILTER (WHERE os.created_at >= ((b.today_local - interval '7 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS rows_last_7d,
  count(*) FILTER (WHERE os.created_at >= ((b.today_local - interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS rows_last_14d,
  count(DISTINCT os.order_code) FILTER (WHERE os.created_at >= ((b.today_local - interval '7 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS unique_orders_last_7d,
  count(DISTINCT os.order_code) FILTER (WHERE os.created_at >= ((b.today_local - interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS unique_orders_last_14d
FROM public.order_snapshots os CROSS JOIN bounds b
WHERE os.created_at >= ((b.today_local - interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')
  AND os.created_at < (b.today_local AT TIME ZONE 'Asia/Ho_Chi_Minh');

-- E) Consecutive material-state transitions.
-- Excludes id, created_at, sync_run_id, source_updated_at, and warehouse_log.
WITH ordered AS (
  SELECT
    os.*,
    lag(md5((jsonb_build_array(
      os.source_status, os.reason_code, os.warehouse_id, os.warehouse_name,
      os.weight_kg, os.weight_grams, os.pick_warehouse_id, os.deliver_warehouse_id,
      os.destination_province_id, os.destination_district_id, os.deliver_warehouse_name,
      os.sort_code, os.is_b2b, os.service_type_id, os.order_created_at,
      os.end_pick_at, os.end_delivery_at, os.end_success_at
    ))::text)) OVER (PARTITION BY os.order_code ORDER BY os.created_at, os.id) AS prior_material_signature
  FROM public.order_snapshots os
), transitions AS (
  SELECT *, md5((jsonb_build_array(
    source_status, reason_code, warehouse_id, warehouse_name, weight_kg, weight_grams,
    pick_warehouse_id, deliver_warehouse_id, destination_province_id,
    destination_district_id, deliver_warehouse_name, sort_code, is_b2b, service_type_id,
    order_created_at, end_pick_at, end_delivery_at, end_success_at
  ))::text) AS material_signature
  FROM ordered
  WHERE prior_material_signature IS NOT NULL
)
SELECT
  count(*) AS total_comparable_transitions,
  count(*) FILTER (WHERE material_signature = prior_material_signature) AS unchanged_transitions,
  count(*) FILTER (WHERE material_signature <> prior_material_signature) AS changed_transitions,
  round(100.0 * count(*) FILTER (WHERE material_signature = prior_material_signature) / NULLIF(count(*), 0), 2) AS unchanged_duplicate_rate,
  count(*) FILTER (WHERE material_signature = prior_material_signature) AS estimated_rows_avoidable_if_material_change_only
FROM transitions;

-- E) Top 10 orders by raw snapshot count. Mask order codes before sharing output.
SELECT left(md5(order_code), 12) AS order_key_mask, count(*) AS snapshot_count
FROM public.order_snapshots
GROUP BY order_code
ORDER BY snapshot_count DESC, order_key_mask
LIMIT 10;

-- F) Physical-size and growth inputs for the forecast.
SELECT
  pg_size_pretty(pg_total_relation_size('public.order_snapshots')) AS order_snapshots_total_size,
  pg_total_relation_size('public.order_snapshots') AS order_snapshots_total_size_bytes,
  count(*) AS total_rows,
  min(created_at) AS oldest_created_at,
  max(created_at) AS newest_created_at
FROM public.order_snapshots;
