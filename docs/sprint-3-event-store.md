# Sprint 3: Event Store & Operational Memory Specification

## 1. Overview

Sprint 3 implements persistent storage for OpsPilot, enabling the system to compare operational statuses across sync runs, track incident lifecycles, record historical metrics, and respect approved order exceptions.

---

## 2. Sync & Persistence Lifecycle

```text
1. Create sync_runs row (status: 'running')
       ↓
2. Fetch Rillnet Operations Snapshot
       ↓
3. Normalize Orders
       ↓
4. Load Active Exceptions (order_exceptions table)
       ↓
5. Apply Rule Engine (Filter out exceptions & terminal orders)
       ↓
6. Aggregate Incidents (generate stable incident_key = warehouseId:reasonCode)
       ↓
7. Batch Save Order Snapshots (batch size: 500)
       ↓
8. Upsert Incidents (update last_detected_at, priority_score, last_sync_run_id)
       ↓
9. Insert Incident History (sample max 5 order codes, UNIQUE on incident_id + sync_run_id)
       ↓
10. Resolve Absent Incidents (mark status = 'resolved', set resolved_at = now())
       ↓
11. Update sync_runs row (status: 'success', duration_ms, counts)
```

---

## 3. Incident Lifecycle Rules

- **Open**: Newly created or active in current sync run.
- **Monitoring**: Under observation without active priority escalation.
- **Resolved**: Automatically transitioned to `resolved` when absent from a subsequent successful sync run (`resolved_at = now()`).
- **Ignored**: Manually flagged to bypass push notifications.

---

## 4. Batching Strategy & Performance Targets

- **Batch Size**: 500 rows per upsert call in `OrderSnapshotRepository`.
- **Target Performance**: Rule and incident processing for 15,000 orders executes under 500 ms (excluding network I/O).
- **Retry Idempotency**: `(incident_id, sync_run_id)` unique constraint prevents duplicate history rows if a sync job retries.
