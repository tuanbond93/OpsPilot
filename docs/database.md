# OpsPilot Database Schema Specification

This document details the PostgreSQL database schema used for OpsPilot Event Store & Operational Memory.

---

## Tables Overview

### 1. `sync_runs`
Tracks every Rillnet synchronization run attempt.
- `id` (UUID, Primary Key)
- `started_at` (TIMESTAMPTZ, NOT NULL)
- `completed_at` (TIMESTAMPTZ)
- `status` (TEXT, Allowed: `'running'`, `'success'`, `'failed'`)
- `fetched_order_count` (INTEGER, Default: `0`)
- `normalized_order_count` (INTEGER, Default: `0`)
- `incident_count` (INTEGER, Default: `0`)
- `duration_ms` (INTEGER)
- `source_updated_at` (TIMESTAMPTZ)
- `error_code` (TEXT)
- `error_message` (TEXT)
- `created_at` (TIMESTAMPTZ, Default: `NOW()`)

---

### 2. `order_snapshots`
Stores operational snapshots of orders per sync run.
- `id` (BIGINT, Identity Primary Key)
- `sync_run_id` (UUID, Foreign Key ➔ `sync_runs.id`)
- `order_code` (TEXT, NOT NULL)
- `warehouse_id` (TEXT)
- `warehouse_name` (TEXT)
- `source_status` (TEXT, NOT NULL)
- `task_category` (TEXT)
- `reason_code` (TEXT)
- `order_created_at` (TIMESTAMPTZ)
- `source_updated_at` (TIMESTAMPTZ)
- `age_hours` (NUMERIC)
- `created_at` (TIMESTAMPTZ, Default: `NOW()`)
- **Constraints**: `UNIQUE(sync_run_id, order_code, warehouse_id, source_status)`

---

### 3. `incidents`
Stores current lifecycle state of aggregated operational incidents.
- `id` (UUID, Primary Key)
- `incident_key` (TEXT, UNIQUE, Format: `warehouseId:reasonCode`)
- `warehouse_id` (TEXT, NOT NULL)
- `warehouse_name` (TEXT)
- `reason_code` (TEXT, NOT NULL)
- `reason_name` (TEXT, NOT NULL)
- `status` (TEXT, Default: `'open'`, Allowed: `'open'`, `'monitoring'`, `'resolved'`, `'ignored'`)
- `priority_score` (INTEGER, Default: `0`)
- `first_detected_at` (TIMESTAMPTZ, NOT NULL)
- `last_detected_at` (TIMESTAMPTZ, NOT NULL)
- `resolved_at` (TIMESTAMPTZ)
- `last_sync_run_id` (UUID, Foreign Key ➔ `sync_runs.id`)
- `created_at` (TIMESTAMPTZ, Default: `NOW()`)
- `updated_at` (TIMESTAMPTZ, Auto-updated via trigger)

---

### 4. `incident_history`
Stores incident metrics timeline at every synchronization run.
- `id` (BIGINT, Identity Primary Key)
- `incident_id` (UUID, Foreign Key ➔ `incidents.id`)
- `sync_run_id` (UUID, Foreign Key ➔ `sync_runs.id`)
- `recorded_at` (TIMESTAMPTZ, NOT NULL)
- `affected_order_count` (INTEGER, NOT NULL)
- `average_age_hours` (NUMERIC)
- `maximum_age_hours` (NUMERIC)
- `oldest_order_code` (TEXT)
- `priority_score` (INTEGER, NOT NULL)
- `sample_order_codes` (JSONB, Default: `'[]'::jsonb`, Max 5 items)
- `created_at` (TIMESTAMPTZ, Default: `NOW()`)
- **Constraints**: `UNIQUE(incident_id, sync_run_id)`

---

### 5. `order_exceptions`
Stores approved exception reasons excluding orders from incidents & push triggers.
- `id` (UUID, Primary Key)
- `order_code` (TEXT, NOT NULL)
- `reason_code` (TEXT, Allowed: `'CUSTOMER_APPOINTMENT'`, `'MISSING_PACKAGE'`, `'MISSING_DOCUMENT'`, `'DAMAGED'`, `'CS_RESCHEDULED'`)
- `reason_name` (TEXT, NOT NULL)
- `note` (TEXT)
- `approved_by` (TEXT)
- `starts_at` (TIMESTAMPTZ, Default: `NOW()`)
- `expires_at` (TIMESTAMPTZ)
- `active` (BOOLEAN, Default: `true`)
- `created_at` (TIMESTAMPTZ, Default: `NOW()`)
- `updated_at` (TIMESTAMPTZ, Auto-updated via trigger)
