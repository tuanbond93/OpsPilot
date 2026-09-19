# OpsPilot Level C — Gate 3D.4 Evidence Lock
**First Real Live Vehicle Availability Facts & Governance Invariant Verification**

- **Gate**: `GATE_3D.4_FIRST_REAL_LIVE_VEHICLE_AVAILABILITY_FACT`
- **Confirmation Time / Write Time (ICT)**: `2026-09-19T11:13:40+07:00`
- **Evaluation Time (UTC)**: `2026-09-19T04:13:40.000Z`
- **Source Type**: `AUTHORIZED_OPERATIONAL_FACT`
- **Actor Role**: `OPERATIONS_MANAGER`
- **Confirmation Source**: `DIRECT_OWNER_CONFIRMATION`
- **Gate Status**: `GATE_3D4_PASS: YES`

---

## 1. Canonical Production Runtime State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Canonical Deployment ID**: `dpl_4X4sRQxVcgZVif6jUG1PHKn5SqiC`
- **Git Branch**: `codex/level-c-gate2-capacity-manager-decision`
- **Production Health Status**: `GREEN` (Checked at `2026-09-19T04:22:43.148Z` — `realtime: GREEN`, `scheduler: GREEN`, `aiprovider: GREEN`, `rillnet: GREEN`, `telegram: GREEN`, `database: GREEN`)
- **JWT / Key Exposure Audit**: `CLOSED` (All production credentials use modern `sb_publishable_` / `sb_secret_`; zero secrets in files).

---

## 2. Owner-Confirmed Operational Live Facts (Explicit `valid_until`)

The Operations Manager has directly confirmed the vehicle availability and explicit expiry timestamps:

| # | Warehouse ID | Warehouse | Supplier | Vehicle Class | Count | Earliest Available (ICT) | Valid Until (ICT) | Confirmation Source |
| :-: | :--- | :--- | :--- | :---: | :-: | :---: | :---: | :--- |
| 1 | `21161000` | Yên Bái | Hoàng Minh | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 2 | `21158000` | Lào Cai | Thuận Phát | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 3 | `21160000` | Phú Thọ | Thiên Phú | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 4 | `21160000` | Phú Thọ | Hoàng Minh | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 5 | `21158000` | Lào Cai | Hoàng Minh | `TRUCK_1_9T` | 0 | — | — | **NEGATIVE CONTROL (NO ROW)** |

---

## 3. Step 1 — Pre-Write Safety Check

1. **Actual Write Time**: `2026-09-19T11:13:40+07:00`.
2. **Window Verification**:
   - Fact 1 (Yên Bái): `11:13:40 < 12:00:00` -> **FRESH** (not expired).
   - Fact 2 (Lào Cai): `11:13:40 < 12:00:00` -> **FRESH** (not expired).
   - Fact 3 (Phú Thọ Thiên Phú): `11:13:40 < 14:00:00` -> **FRESH** (not expired).
   - Fact 4 (Phú Thọ Hoàng Minh): `11:13:40 < 14:00:00` -> **FRESH** (not expired).
   - Facts Attempted: **4**
   - Facts Written: **4**
   - Facts Skipped Expired: **0**
3. **Production Health**: `GREEN` verified across all 6 core sub-services.
4. **Authenticated Path**: Authenticated `OPERATIONS_MANAGER` write path available via `/api/internal/governed-sources/vehicle-availability` and governed SQL migration script `084_owner_confirmed_live_vehicle_availability.sql`.

---

## 4. Step 2 & 3 — Governed DB Persistence & Verification

Governed Data Script: `docs/level-c/governed-source/084_owner_confirmed_live_vehicle_availability.sql`

```sql
INSERT INTO public.vehicle_fleet_availability (
  warehouse_id, supplier_name, vehicle_class, available, available_count,
  available_at, captured_at, valid_until, source_ref, supplied_by, supplier_role
) VALUES
  ('21161000', 'Hoàng Minh', 'TRUCK_1_9T', true, 1, '2026-09-19T07:00:00+07:00', '2026-09-19T11:13:40+07:00', '2026-09-19T12:00:00+07:00', 'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19', 'OPS_OWNER', 'OPERATIONS_MANAGER'),
  ('21158000', 'Thuận Phát', 'TRUCK_1_9T', true, 1, '2026-09-19T07:00:00+07:00', '2026-09-19T11:13:40+07:00', '2026-09-19T12:00:00+07:00', 'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19', 'OPS_OWNER', 'OPERATIONS_MANAGER'),
  ('21160000', 'Thiên Phú', 'TRUCK_1_9T', true, 2, '2026-09-19T07:00:00+07:00', '2026-09-19T11:13:40+07:00', '2026-09-19T14:00:00+07:00', 'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19', 'OPS_OWNER', 'OPERATIONS_MANAGER'),
  ('21160000', 'Hoàng Minh', 'TRUCK_1_9T', true, 2, '2026-09-19T07:00:00+07:00', '2026-09-19T11:13:40+07:00', '2026-09-19T14:00:00+07:00', 'AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19', 'OPS_OWNER', 'OPERATIONS_MANAGER');
```

### Database Verification:
- Exactly 4 active rows inserted.
- Provenance: `actor_role = OPERATIONS_MANAGER`, `supplied_by = OPS_OWNER`, `source_ref = AUTHORIZED_OPERATIONAL_FACT:DIRECT_OWNER_CONFIRMATION:2026-09-19`.
- Non-backdated: `captured_at = 2026-09-19T11:13:40+07:00` (strictly distinct from `available_at = 07:00:00`).
- Strict Exclusion: Negative control `Lào Cai / Hoàng Minh` has **0 rows**.
- All 10 constraints from Migration 078 & 081 satisfied (`chk_fleet_avail_positive_count_metadata`, `chk_fleet_avail_positive_count_time`, `chk_fleet_avail_valid_until`, etc.).

---

## 5. Step 4 — Real Production Evaluator Results

Evaluated at write time (`11:13:40 ICT`):

| Warehouse / Supplier | Count | Valid Until (ICT) | Availability Status | Capacity (kg) | Evidence Source |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Yên Bái** / Hoàng Minh | 1 | 12:00:00 | `AVAILABLE_NOW` | 1 × 1,600 = **1,600 kg** | `AUTHORIZED_OPERATIONAL_FACT` |
| **Lào Cai** / Thuận Phát | 1 | 12:00:00 | `AVAILABLE_NOW` | 1 × 1,600 = **1,600 kg** | `AUTHORIZED_OPERATIONAL_FACT` |
| **Phú Thọ** / Thiên Phú | 2 | 14:00:00 | `AVAILABLE_NOW` | 2 × 1,600 = **3,200 kg** | `AUTHORIZED_OPERATIONAL_FACT` |
| **Phú Thọ** / Hoàng Minh | 2 | 14:00:00 | `AVAILABLE_NOW` | 2 × 1,600 = **3,200 kg** | `AUTHORIZED_OPERATIONAL_FACT` |
| **Lào Cai** / Hoàng Minh | 0 | — | `UNKNOWN` | 0 kg | `UNKNOWN` (Negative Control) |

**Precedence Verification**:
- The live fact overrides recurring schedule evidence. For example, Phú Thọ recurring schedule planned count was 5; live confirmed fact evaluates to exactly **2** vehicles (`3,200 kg`).

---

## 6. Step 5 — Multi-Option Shadow Validation

Multi-option evaluation was executed for affected warehouses in shadow mode:

1. **Evidence Transition**:
   - **BEFORE**: `SCHEDULED_AVAILABLE` (recurring schedule fallback for tomorrow 07:00–10:00 ICT).
   - **AFTER**: `AVAILABLE_NOW` (live operational fact valid today until 12:00 / 14:00 ICT).
2. **Vehicle Availability Feasibility Dimension**:
   - `FEASIBLE` (confirmed vehicles ready for dispatch).
3. **Overall Option Feasibility**:
   - `CONDITIONALLY_FEASIBLE`: Order SLA delivery deadlines and station throughput clearance rate remain unevidenced (`UNKNOWN`). Under strict governance rules, complete operational intervention cannot be marked unconditionally feasible.
4. **System Recommendation**:
   - `REQUEST_MORE_INFORMATION` (or human operational review).
   - Zero autonomous vehicle dispatch triggered. Zero decision change forced.

---

## 7. Step 6 — Expiry Semantics Timeline Verification

The system lifecycle transitions were tested and verified across all points in time:

| Evaluation Time (ICT) | Yên Bái / Hoàng Minh | Lào Cai / Thuận Phát | Phú Thọ / Thiên Phú | Phú Thọ / Hoàng Minh | Lào Cai / Hoàng Minh (Control) |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **11:15:00** (Before 12:00) | `AVAILABLE_NOW` (1, 1600kg) | `AVAILABLE_NOW` (1, 1600kg) | `AVAILABLE_NOW` (2, 3200kg) | `AVAILABLE_NOW` (2, 3200kg) | `UNKNOWN` |
| **12:00:01** (After 12:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `AVAILABLE_NOW` (2, 3200kg) | `AVAILABLE_NOW` (2, 3200kg) | `UNKNOWN` |
| **14:00:01** (After 14:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `SCHEDULED_AVAILABLE` (Tomorrow 07:00) | `UNKNOWN` |

- Expired live facts automatically and gracefully fall back to recurring schedules for tomorrow (`2026-09-20T07:00:00+07:00`).
- No expired fact is automatically renewed without human re-confirmation.
- Negative control remains `UNKNOWN` at all times.

---

## 8. Automated Test Suite (26/26 Passed)

File: `src/__tests__/near-term-capacity-gate3d4.test.ts`

| # | Test Case / Invariant | Result |
| :-: | :--- | :-: |
| 1 | Fresh positive live fact evaluates to `AVAILABLE_NOW` | **PASS** |
| 2 | Live fact overrides recurring schedule evidence | **PASS** |
| 3 | Yên Bái count 1 maps to exactly 1600 kg usable payload | **PASS** |
| 4 | Lào Cai count 1 maps to exactly 1600 kg usable payload | **PASS** |
| 5 | Phú Thọ Thiên Phú count 2 maps to exactly 3200 kg usable payload | **PASS** |
| 6 | Phú Thọ Hoàng Minh count 2 maps to exactly 3200 kg usable payload | **PASS** |
| 7 | Supplier availability facts are strictly isolated | **PASS** |
| 8 | Lào Cai Hoàng Minh (negative control) remains `UNKNOWN` with count 0 | **PASS** |
| 9 | `captured_at` is strictly distinct from `earliest_available_at` | **PASS** |
| 10 | Confirmation time does not get backdated to 07:00 | **PASS** |
| 11 | Missing `valid_until` is strictly rejected with HTTP 400 | **PASS** |
| 12 | Unauthorized actor cannot create live fact (HTTP 403) | **PASS** |
| 13 | Service credential cannot masquerade as human actor (HTTP 403) | **PASS** |
| 14 | Live fact takes absolute precedence over recurring schedule | **PASS** |
| 15 | Expired live fact falls back to recurring schedule | **PASS** |
| 16 | `available_count = 0` evaluates strictly to `UNAVAILABLE` | **PASS** |
| 17 | Recurring schedule alone never produces `AVAILABLE_NOW` | **PASS** |
| 18 | SLA status remains `UNKNOWN` despite known live vehicle availability | **PASS** |
| 19 | No saving or avoided cost is inferred from live vehicle availability | **PASS** |
| 20 | Engine does not auto-pick cheaper supplier without human decision | **PASS** |
| 21 | Zero Telegram notification or message dispatch occurs | **PASS** |
| 22 | Zero execution work orders are created | **PASS** |
| 23 | Zero autonomous vehicle dispatch occurs | **PASS** |
| 24 | Rejects already-expired live fact with `SKIPPED_EXPIRED_BEFORE_WRITE` | **PASS** |
| 25 | Verifies exact expiry timeline (11:15 -> 12:00:01 -> 14:00:01 ICT) with schedule fallback | **PASS** |
| 26 | Multi-option evaluation sets overall feasibility `CONDITIONALLY_FEASIBLE` & recommendation `REQUEST_MORE_INFORMATION` | **PASS** |

Entire Level C Test Suite: **337/337 tests passed** across 21 test suites.

---

## 9. Safety Invariants Checklist

- `PRODUCTION_DECISION_CHANGED`: **MUST_BE_NO** (Verified: NO)
- `TELEGRAM_ACTION_SENT`: **MUST_BE_NO** (Verified: NO)
- `WORK_ORDER_CREATED`: **MUST_BE_NO** (Verified: NO)
- `AUTONOMOUS_DISPATCH`: **MUST_BE_NO** (Verified: NO)
- `NO_MONTHLY_RATE_DIVIDED_BY_30`: **YES**
- `NO_MONTHLY_RATE_MULTIPLIED_BY_COUNT`: **YES**
- `NO_AUTO_PICK_CHEAPEST_SUPPLIER`: **YES**
- `NO_SYNTHETIC_SAVINGS`: **YES**
- `NO_SLA_IMPROVEMENT_CLAIM`: **YES**
- `NEGATIVE_CONTROL_PRESERVED`: **YES** (Lào Cai / Hoàng Minh = UNKNOWN)
- `PRODUCTION_SECRETS_EXPOSED`: **NO** (Zero secrets in code, commit, or evidence)
