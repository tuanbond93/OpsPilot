# Snapshot Storage V3 — Shadow Implementation

Status: shadow-only. `SNAPSHOT_V3_SHADOW_ENABLED` defaults to `false`.

The existing `order_snapshots` table remains authoritative. No existing reader
is redirected, no legacy row is deleted, and no retention cleanup is activated.

## Warehouse-log decision

Classification: **C — mixed/unknown**.

Evidence:

- `src/connectors/rillnet/mapper.ts` maps the source `warehouse_log` into the
  normalized order as journey evidence.
- `src/app/api/incidents/[incidentId]/orders/[orderCode]/live-status/route.ts`
  appends `__opspilot_live_tracking_v1` tracking markers to the same JSON array.
- `src/app/incidents/[incidentId]/orderJourney.ts` treats source logs as
  authoritative visits and uses the snapshot history only as a legacy fallback.

Because a clean split is not proven, V3 retains the canonicalized full
`warehouse_log` array in `material_state` during shadow validation. It must not
be dropped from the hash. A future read-cutover design may split source journey
events and mutable bridge-cache metadata into separate append-only tables.

## Completion and failure boundary

Legacy persistence happens first. V3 shadow writes are deferred until the sync
has reached `COMPLETED`. A failed or partial sync therefore cannot become a
valid V3 reconstructable cohort. V3 write or comparison failures are logged as
shadow failures and never fail the legacy sync.

## Reconstruction and comparison

`sync_run_order_refs` preserves the legacy identity dimensions:

```text
(sync_run_id, order_code, warehouse_id, source_status)
```

`reason_code` and `evaluation_reference_at` remain run-specific reference data.
`age_hours` is reconstructed from the order creation timestamp and the stored
evaluation reference time using the legacy one-decimal rounding semantics.

The comparator checks row count, order-code set, identity multiset, material
state, age, reason, source freshness, and journey evidence.
Results are also written to `snapshot_v3_shadow_comparisons` when the optional
repository method is available, so the consecutive-checkpoint gate is durable.

## Rollback

Set `SNAPSHOT_V3_SHADOW_ENABLED=false` and leave all legacy readers and writers
unchanged. The shadow tables are not read by operational application paths.

The migration is prepared only and has not been executed.
