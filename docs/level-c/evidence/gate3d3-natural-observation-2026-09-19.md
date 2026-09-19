# OpsPilot Level C — Gate 3D.3 Evidence Lock
**Natural Recurring Availability Observation Evidence**

- **Evidence Origin**: `NATURAL_RECURRING_AVAILABILITY_OBSERVATION`
- **Captured At (UTC)**: `2026-09-19T01:22:47.248Z`
- **Captured At (ICT)**: `2026-09-19T08:22:47+07:00`
- **Timezone**: `Asia/Ho_Chi_Minh`
- **Operating Window**: `07:00:00` inclusive to `10:00:00` exclusive
- **Natural Window Active**: `YES` (`07:00:00 <= 08:22:47 < 10:00:00`)

---

## 1. Canonical Production Runtime State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Canonical Deployment ID**: `dpl_4JkRYrvBkxcWt13ZEBK46EyLatKB`
- **Git Head & Deployed Commit**: `88e7894e9cce048b0eef22015a24128c0c8fb39a` (`88e7894`)
- **Canonical Commit Match**: `YES`
- **Safety Precondition**: `LEVEL_C_VERIFY_SHADOW_ENABLED` is `false` (default); verification test route disabled (`HTTP 404`).

---

## 2. Production Database Read (Read-Only)

### A. Table: `public.vehicle_fleet_availability_schedules`
- **Production DB Read Status**: `SUCCESS`
- **Row Count**: `4`

```json
[
  {
    "warehouse_id": "21158000",
    "supplier_name": "Thuận Phát",
    "vehicle_class": "TRUCK_1_9T",
    "planned_available_count": 2,
    "recurrence_type": "DAILY",
    "timezone": "Asia/Ho_Chi_Minh",
    "local_start_time": "07:00:00",
    "local_end_time": "10:00:00",
    "effective_from": "2026-09-19",
    "effective_until": null,
    "provenance_status": "OWNER_CONFIRMED_RECURRING_SCHEDULE"
  },
  {
    "warehouse_id": "21160000",
    "supplier_name": "Hoàng Minh",
    "vehicle_class": "TRUCK_1_9T",
    "planned_available_count": 5,
    "recurrence_type": "DAILY",
    "timezone": "Asia/Ho_Chi_Minh",
    "local_start_time": "07:00:00",
    "local_end_time": "10:00:00",
    "effective_from": "2026-09-19",
    "effective_until": null,
    "provenance_status": "OWNER_CONFIRMED_RECURRING_SCHEDULE"
  },
  {
    "warehouse_id": "21160000",
    "supplier_name": "Thiên Phú",
    "vehicle_class": "TRUCK_1_9T",
    "planned_available_count": 5,
    "recurrence_type": "DAILY",
    "timezone": "Asia/Ho_Chi_Minh",
    "local_start_time": "07:00:00",
    "local_end_time": "10:00:00",
    "effective_from": "2026-09-19",
    "effective_until": null,
    "provenance_status": "OWNER_CONFIRMED_RECURRING_SCHEDULE"
  },
  {
    "warehouse_id": "21161000",
    "supplier_name": "Hoàng Minh",
    "vehicle_class": "TRUCK_1_9T",
    "planned_available_count": 1,
    "recurrence_type": "DAILY",
    "timezone": "Asia/Ho_Chi_Minh",
    "local_start_time": "07:00:00",
    "local_end_time": "10:00:00",
    "effective_from": "2026-09-19",
    "effective_until": null,
    "provenance_status": "OWNER_CONFIRMED_RECURRING_SCHEDULE"
  }
]
```

### B. Table: `public.vehicle_fleet_availability` (Point-in-Time Live Facts)
- **Pilot Warehouses Scoped**: `21161000` (Yên Bái), `21158000` (Lào Cai), `21160000` (Phú Thọ)
- **Active Fact Row Count**: `0`
- **Fresh Live Fact Override Found**: `NO`

---

## 3. Real Runtime Evaluated Matrix

Evaluated using `GovernedVehicleSourceAdapter` connected to production Supabase at actual execution time `2026-09-19T08:22:47+07:00`:

| Warehouse | Supplier | Vehicle Class | Planned Count | Planned Capacity (kg) | Availability Status | Feasibility Status | Feasible | Evidence Status |
| :--- | :--- | :--- | :---: | :---: | :--- | :--- | :---: | :--- |
| **Yên Bái** (`21161000`) | Hoàng Minh | `TRUCK_1_9T` | 1 | 1,600 | `PLANNED_AVAILABLE_NOW` | `CONDITIONALLY_FEASIBLE` | `false` | `OWNER_CONFIRMED_RECURRING_SCHEDULE` |
| **Lào Cai** (`21158000`) | Thuận Phát | `TRUCK_1_9T` | 2 | 3,200 | `PLANNED_AVAILABLE_NOW` | `CONDITIONALLY_FEASIBLE` | `false` | `OWNER_CONFIRMED_RECURRING_SCHEDULE` |
| **Lào Cai** (`21158000`) | Hoàng Minh | `TRUCK_1_9T` | — | — | `UNKNOWN` | `CONDITIONALLY_FEASIBLE` | `false` | `UNKNOWN` |
| **Phú Thọ** (`21160000`) | Thiên Phú | `TRUCK_1_9T` | 5 | 8,000 | `PLANNED_AVAILABLE_NOW` | `CONDITIONALLY_FEASIBLE` | `false` | `OWNER_CONFIRMED_RECURRING_SCHEDULE` |
| **Phú Thọ** (`21160000`) | Hoàng Minh | `TRUCK_1_9T` | 5 | 8,000 | `PLANNED_AVAILABLE_NOW` | `CONDITIONALLY_FEASIBLE` | `false` | `OWNER_CONFIRMED_RECURRING_SCHEDULE` |

---

## 4. Evidence Integrity & Overclaim Guardrails

- **`RECURRING_SCHEDULE_ALONE_MARKED_FEASIBLE`**: `NO` (`feasible: false`).
- **`AVAILABLE_NOW` Produced**: `NO` (strictly `PLANNED_AVAILABLE_NOW` with `available: false`).
- **Realized Saving Claimed**: `NO` (zero synthetic daily or realized savings generated).
- **Cost Multiplier Applied**: `NO` (monthly rental rate preserved; not multiplied by planned count, not divided by 30).
- **Free/Dispatchable Vehicles Claimed**: `NO` (represents planned capacity boundary only).

---

## 5. Safety Invariants Verification

- `FIXTURE_TIME_USED`: `NO`
- `MOCK_SCHEDULE_ROWS_USED`: `NO`
- `HISTORICAL_REPLAY_USED`: `NO`
- `SYNTHETIC_LIVE_FACT_USED`: `NO`
- `PRODUCTION_DECISION_CHANGED`: `NO`
- `TELEGRAM_SENT`: `NO`
- `WORK_ORDER_CREATED`: `NO`
- `LIVE_FACT_INSERTED`: `NO`
- `SCHEDULE_ROWS_MUTATED`: `NO`
- `CASE_MUTATED`: `NO`
