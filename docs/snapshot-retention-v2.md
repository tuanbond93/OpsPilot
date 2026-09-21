# Snapshot Retention V2

## Contract

`order_snapshots` has a 21-day operational retention window. The canonical
application constant is `ORDER_SNAPSHOT_RETENTION_DAYS` in
`src/config/retention.ts`.

Durable incident, follow-up, triage, decision, planner, checkpoint, shadow,
and outcome evidence is retained separately. Raw order-level detail is not
silently reconstructed from aggregate evidence.

## Expired-detail behavior

- `AVAILABLE`: raw rows are present.
- `NOT_FOUND`: the referenced run is within the retention window, but no raw
  rows match the requested scope.
- `EXPIRED_BY_RETENTION`: the referenced historical run is older than the
  retention window. Aggregate/audit evidence remains available where present.

Recent incident order detail remains unchanged. Older incident order detail
returns an explicit retention state and a historical summary when available.
Root Cause does not use a current live snapshot as a substitute for expired
historical journey evidence.

## Automatic cleanup design — not activated

Owner approval is still required before production cleanup is enabled. The
recommended job is one bounded, idempotent daily batch using the predicate:

```sql
created_at < now() - interval '21 days'
```

The job should delete a small fixed batch per transaction, commit between
batches, record candidate/deleted/error counts, retry safely by reusing the
same predicate, and stop on lock-timeout or repeated errors. It must not run
`VACUUM FULL`, and it must not delete from durable evidence tables.

## Ingestion-volume follow-up

The repository currently does not contain a production aggregate that can
reliably calculate unique orders/day, snapshots/order/day, p50/p95 snapshot
frequency, or unchanged-material-state duplication. Those metrics require a
read-only production query over `order_snapshots` grouped by `created_at` and
`order_code`; no such query was executed as part of this implementation.
