# OpsPilot Level C — Gate 3D.4 Evidence Lock
**First Real Live Vehicle Availability Fact & Governance Invariant Verification**

- **Gate**: `GATE_3D.4_FIRST_REAL_LIVE_VEHICLE_AVAILABILITY_FACT`
- **Captured At (UTC)**: `2026-09-19T03:51:30.000Z`
- **Captured At (ICT)**: `2026-09-19T10:51:30+07:00`
- **Source Type**: `AUTHORIZED_OPERATIONAL_FACT`
- **Actor Role**: `OPERATIONS_MANAGER`
- **Confirmation Source**: `DIRECT_OWNER_CONFIRMATION`
- **Status**: `LIVE_FACT_WRITE_BLOCKED: OWNER_VALID_UNTIL_REQUIRED`

---

## 1. Canonical Production Runtime State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Canonical Deployment ID**: `dpl_4X4sRQxVcgZVif6jUG1PHKn5SqiC`
- **Git Branch**: `codex/level-c-gate2-capacity-manager-decision`
- **Deployed Commit**: `6221819`
- **Production Health Status**: `GREEN`

---

## 2. Owner-Confirmed Operational Availability Facts

The Operations Manager provided direct confirmation for the following vehicle availability:

| Warehouse ID | Warehouse Name | Supplier | Vehicle Class | Available Count | Available Since (ICT) | Confirmation Source |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| `21161000` | Yên Bái | Hoàng Minh | `TRUCK_1_9T` | 1 | `07:00 Asia/Ho_Chi_Minh today` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| `21158000` | Lào Cai | Thuận Phát | `TRUCK_1_9T` | 1 | `07:00 Asia/Ho_Chi_Minh today` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| `21160000` | Phú Thọ | Thiên Phú | `TRUCK_1_9T` | 2 | `07:00 Asia/Ho_Chi_Minh today` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| `21160000` | Phú Thọ | Hoàng Minh | `TRUCK_1_9T` | 2 | `07:00 Asia/Ho_Chi_Minh today` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| `21158000` | Lào Cai | Hoàng Minh (Control) | `TRUCK_1_9T` | 0 | None | *Negative Control (No fact)* |

---

## 3. Governed Model Inspection & Expiry Governance Audit

### Mandatory Stop Condition Invoked
The Operations Manager did **not** supply an explicit `valid_until` timestamp. Under Gate 3D.4 instructions:
> *"Do NOT invent: 12:00, end of day, +1 hour, +2 hours or any arbitrary TTL presented as an owner-confirmed expiry. First inspect the existing governed live availability model. If valid_until is optional: store NULL... If the schema absolutely requires valid_until and there is no existing governed freshness mechanism that can safely derive it: STOP BEFORE INSERTING. Return: LIVE_FACT_WRITE_BLOCKED: OWNER_VALID_UNTIL_REQUIRED. Do not fabricate the missing value."*

### Database Schema Audit:
1. **`public.vehicle_fleet_availability`** (`078_governed_vehicle_source_infrastructure.sql` L58):
   - `valid_until TIMESTAMPTZ NOT NULL`
2. **Constraints** (`081_vehicle_fleet_availability_supplier_and_count.sql`):
   - `chk_fleet_avail_count_metadata`: Requires `valid_until IS NOT NULL` whenever `available_count IS NOT NULL`.
   - `chk_fleet_avail_positive_count_time`: Requires `available_at <= valid_until`.
   - `chk_fleet_avail_valid_until`: Requires `valid_until >= captured_at`.
3. **Application Validation**:
   - `validateVehicleAvailabilityInput` (`src/domain/near-term-capacity/multi-option/sources/vehicle-availability-service.ts` L216):
     Strictly returns `HTTP 400: MISSING_FIELD: valid_until is required; TTL must not be silently invented.`
   - `validateCandidateVehicleAvailability` (`src/domain/near-term-capacity/multi-option/sources/governed-source-validator.ts` L243):
     Rejects with `MISSING_VALID_UNTIL: valid_until must be a valid ISO timestamp and cannot be empty.`

### Audit Conclusion:
`valid_until` is strictly non-nullable in PostgreSQL and required by business validators. There is no governed fallback policy to invent a TTL.
**Write to production database was therefore halted**: `LIVE_FACT_WRITE_BLOCKED: OWNER_VALID_UNTIL_REQUIRED`.
Total live fact rows written to production DB: **0**.

---

## 4. Phase A — Pre-Write Read-Only Baseline

Evaluated at real production system time (`> 10:00 ICT` post-window):

| Warehouse | Supplier | Planned Count | Recurring Schedule Status | Evaluated Window (ICT) |
| :--- | :--- | :---: | :---: | :---: |
| **Yên Bái** (`21161000`) | Hoàng Minh | 1 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` to `10:00:00+07:00` |
| **Lào Cai** (`21158000`) | Thuận Phát | 2 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` to `10:00:00+07:00` |
| **Phú Thọ** (`21160000`) | Thiên Phú | 5 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` to `10:00:00+07:00` |
| **Phú Thọ** (`21160000`) | Hoàng Minh | 5 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` to `10:00:00+07:00` |
| **Lào Cai** (`21158000`) | Hoàng Minh (Ctrl) | 0 | `UNKNOWN` | `null` |

---

## 5. Capacity Semantics & Usable Payload Verification

- Governed Usable Payload for `TRUCK_1_9T`: **1,600 kg** (defined in `governed_vehicle_classes`).
- When verified live facts are active:
  - **Yên Bái / Hoàng Minh**: 1 vehicle × 1,600 kg = **1,600 kg**
  - **Lào Cai / Thuận Phát**: 1 vehicle × 1,600 kg = **1,600 kg**
  - **Phú Thọ / Thiên Phú**: 2 vehicles × 1,600 kg = **3,200 kg**
  - **Phú Thọ / Hoàng Minh**: 2 vehicles × 1,600 kg = **3,200 kg**
- Strict Isolation: Multi-supplier capacities are not aggregated into a single pool without explicit multi-supplier composition policies.

---

## 6. Option Evaluation & Feasibility Semantics

- **Vehicle Availability Dimension**: Fresh positive live fact elevates vehicle availability feasibility from `CONDITIONALLY_FEASIBLE` to `FEASIBLE`.
- **Overall Operational Option Feasibility**: Remains strictly governed. Because order SLA deadlines and station clearance throughput remain unevidenced / `UNKNOWN`, overall option recommendation safely resolves to `REQUEST_MORE_INFORMATION` rather than premature autonomous dispatch.
- **Economic Invariant**: Monthly contractual rates are neither divided by 30 nor multiplied by vehicle count; zero synthetic savings claimed.

---

## 7. Gate 3D.4 Comprehensive Test Suite (23/23 Passed)

File: `src/__tests__/near-term-capacity-gate3d4.test.ts`

| # | Invariant / Requirement | Verified Behavior | Status |
| :---: | :--- | :--- | :---: |
| 1 | Fresh positive live fact -> `AVAILABLE_NOW` | Evaluated at 10:46 ICT with 07:00 availability resolves to `AVAILABLE_NOW` | **PASS** |
| 2 | Live fact overrides recurring schedule | Live fact status (`AVAILABLE_NOW`, count 1) takes absolute precedence over recurring schedule | **PASS** |
| 3 | Yên Bái count 1 -> 1600 kg | 1 vehicle × 1600 kg = 1600 kg | **PASS** |
| 4 | Lào Cai count 1 -> 1600 kg | 1 vehicle × 1600 kg = 1600 kg | **PASS** |
| 5 | Phú Thọ Thiên Phú count 2 -> 3200 kg | 2 vehicles × 1600 kg = 3200 kg | **PASS** |
| 6 | Phú Thọ Hoàng Minh count 2 -> 3200 kg | 2 vehicles × 1600 kg = 3200 kg | **PASS** |
| 7 | Supplier isolation | Thiên Phú and Hoàng Minh maintain independent counts and evidence | **PASS** |
| 8 | Negative control | Lào Cai / Hoàng Minh has no fact and no schedule -> `UNKNOWN` | **PASS** |
| 9 | `observed_at` distinct from `earliest_available_at` | `captured_at` (10:46) is distinct from `available_at` (07:00) | **PASS** |
| 10 | Confirmation time not backdated | Verification rejects backdating confirmation to 07:00 | **PASS** |
| 11 | Missing `valid_until` is not fabricated | Rejected with HTTP 400 (`MISSING_FIELD: valid_until is required; TTL must not be silently invented.`) | **PASS** |
| 12 | Unauthorized actor rejected | HTTP 403 returned for unprivileged roles | **PASS** |
| 13 | Service credential cannot self-declare human actor | CRON / SERVICE_ROLE prohibited from impersonating `OPERATIONS_MANAGER` | **PASS** |
| 14 | Live fact precedence over schedule | `AUTHORIZED_OPERATIONAL_FACT` prioritizes ahead of schedule | **PASS** |
| 15 | Expired live fact falls back to schedule | When `evalMs > valid_until`, fallback to recurring schedule occurs smoothly | **PASS** |
| 16 | Zero live availability remains `UNAVAILABLE` | `available_count = 0` resolves to `UNAVAILABLE` | **PASS** |
| 17 | Recurring schedule alone never produces `AVAILABLE_NOW` | Recurring schedule produces `PLANNED_AVAILABLE_NOW` or `SCHEDULED_AVAILABLE` | **PASS** |
| 18 | No SLA inference | SLA deadline remains `UNKNOWN` | **PASS** |
| 19 | No saving inference | No synthetic savings or ROI inferred | **PASS** |
| 20 | No auto supplier selection | Cheapest supplier is not auto-selected | **PASS** |
| 21 | No Telegram action | Zero Telegram messages dispatched | **PASS** |
| 22 | No work order | Zero work orders created | **PASS** |
| 23 | No autonomous dispatch | Decision requires human manager confirmation | **PASS** |

---

## 8. Safety Invariants Summary

- `PRODUCTION_DECISION_CHANGED`: **NO**
- `TELEGRAM_ACTION_SENT`: **NO**
- `WORK_ORDER_CREATED`: **NO**
- `AUTONOMOUS_DISPATCH`: **NO**
- `SAVING_CLAIMED`: **NO**
- `SLA_IMPROVEMENT_CLAIMED`: **NO**
- `LIVE_FACTS_WRITTEN_TO_PROD_DB`: **0** (`BLOCKED_MISSING_TTL`)
