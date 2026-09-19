# OpsPilot Level C — Gate 3D.3B Evidence Lock
**Post-Window Recurring Schedule Rollover Bug (HIGH-1) Confirmation & Fix**

- **Gate**: `GATE_3D.3B_POST_WINDOW_ROLLOVER`
- **Captured At (UTC)**: `2026-09-19T03:27:18.442Z`
- **Captured At (ICT)**: `2026-09-19T10:27:18+07:00`
- **Operating Window**: `07:00:00` inclusive to `10:00:00` exclusive
- **Natural Observation Condition**: `POST_WINDOW` (`10:27:18 >= 10:00:00`)
- **High-1 Status**: `RESOLVED`

---

## 1. Canonical Production Runtime State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Canonical Deployment ID**: `dpl_4X4sRQxVcgZVif6jUG1PHKn5SqiC`
- **Git Branch**: `codex/level-c-gate2-capacity-manager-decision`
- **Deployed Commit**: `015c7cd` (`015c7cd3557e4529dbf7fa089d1502fc273574c2`)
- **Vercel Target**: `production`
- **Production Health Status**: `GREEN` (overallStatus: `GREEN`, checked at `2026-09-19T03:23:50.180Z`)

---

## 2. Pre-Fix Natural Observation (Bug Reproduction)

During Phase A pre-fix natural observation at `2026-09-19T10:10:57+07:00` (after the daily window closed at `10:00:00`), the schedule evaluator was invoked against the 4 live production schedule rows with real system time:

- **OBSERVATION_TIME_UTC**: `2026-09-19T03:10:57.854Z`
- **OBSERVATION_TIME_ICT**: `2026-09-19T10:10:57+07:00`
- **NATURAL_AFTER_WINDOW_OBSERVATION**: `ACTIVE` (`10:10:57 > 10:00:00`)

### Pre-Fix Evaluation Results:

| Warehouse | Supplier | Planned Count | Evaluated Status | Earliest Available At (Pre-Fix) | Valid Until (Pre-Fix) | Defect Observed |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Yên Bái** (`21161000`) | Hoàng Minh | 1 | `SCHEDULED_AVAILABLE` | `2026-09-19T07:00:00:00+07:00` | `2026-09-19T10:00:00:00+07:00` | Expired window today + double seconds |
| **Lào Cai** (`21158000`) | Thuận Phát | 2 | `SCHEDULED_AVAILABLE` | `2026-09-19T07:00:00:00+07:00` | `2026-09-19T10:00:00:00+07:00` | Expired window today + double seconds |
| **Phú Thọ** (`21160000`) | Thiên Phú | 5 | `SCHEDULED_AVAILABLE` | `2026-09-19T07:00:00:00+07:00` | `2026-09-19T10:00:00:00+07:00` | Expired window today + double seconds |
| **Phú Thọ** (`21160000`) | Hoàng Minh | 5 | `SCHEDULED_AVAILABLE` | `2026-09-19T07:00:00:00+07:00` | `2026-09-19T10:00:00:00+07:00` | Expired window today + double seconds |
| **Lào Cai** (`21158000`) | Hoàng Minh (Ctrl) | 0 | `UNKNOWN` | `null` | `null` | Control verified |

- **HIGH_1_REPRODUCED**: `YES`
- **Defects Identified**:
  1. Window did not roll forward to tomorrow (`2026-09-20`) when evaluated after `10:00:00`.
  2. Timestamp string interpolation produced double-seconds `07:00:00:00` when DB field stored `07:00:00`.
  3. Hardcoded `+07:00` offset string rather than dynamic timezone resolution.

---

## 3. Root Cause Analysis

In `src/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter.ts`:
1. `evaluateDailyWindow` marked `isAfterWindow = true`, but returned only `localDate` (the current date).
2. `evaluateScheduleEvidence` always constructed timestamps using `localDate`:
   ```typescript
   const earliestAvailableAt = `${localDate}T${startTime}:00+07:00`;
   const validUntil = `${localDate}T${endTime}:00+07:00`;
   ```
   Regardless of whether `windowEval.isAfterWindow` was `true`, it reused today's date, causing post-window evaluations to reference already-expired time windows.
3. If `startTime` came from the DB as `07:00:00`, appending `:00` resulted in `07:00:00:00`.

---

## 4. Fix Implementation Details

Modified `src/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter.ts`:

1. **`getNextCalendarDate(dateStr: string): string`**:
   - Computes next calendar day in UTC calendar math (`Date.UTC`), cleanly handling month/year rollovers and leap years without timezone distortion.
2. **`normalizeTimeString(timeStr: string): string`**:
   - Parses hour, minute, and second components to guarantee canonical `HH:mm:ss` formatting with no double-seconds.
3. **`getTimeZoneOffsetString(date: Date, timeZone: string): string`**:
   - Dynamically resolves timezone offsets via `Intl.DateTimeFormat(..., { timeZone, timeZoneName: "longOffset" })`.
4. **Target Date Rollover in `evaluateDailyWindow`**:
   - When `isAfterWindow` is `true`, sets `targetDate = getNextCalendarDate(localDate)`.
   - When `isBeforeWindow` or `isWithinWindow`, sets `targetDate = localDate`.
5. **Effective Date Boundary Enforced in `evaluateScheduleEvidence`**:
   - Evaluates `targetStartMs` against `sched.effective_until`. If rollover targets a date beyond `effective_until`, returns `null` (evaluating to `UNKNOWN`), preventing invalid forward rollover.

---

## 5. Comprehensive Regression Test Suite (19/19 Passed)

Executed `src/__tests__/near-term-capacity-gate3d3b.test.ts`:

| # | Test Case Description | Result |
| :---: | :--- | :---: |
| 1 | 06:59 evaluation -> today's 07:00 (`SCHEDULED_AVAILABLE`) | **PASS** |
| 2 | 07:00 evaluation -> today's 07:00 (`PLANNED_AVAILABLE_NOW`) | **PASS** |
| 3 | 09:59 evaluation -> today's 07:00 (`PLANNED_AVAILABLE_NOW`) | **PASS** |
| 4 | 10:00 evaluation -> TOMORROW's 07:00 (`SCHEDULED_AVAILABLE`) | **PASS** |
| 5 | 10:01 evaluation -> TOMORROW's 07:00 (`SCHEDULED_AVAILABLE`) | **PASS** |
| 6 | 23:59 evaluation -> TOMORROW's 07:00 (`SCHEDULED_AVAILABLE`) | **PASS** |
| 7 | `valid_until` always matches corresponding window end date/time | **PASS** |
| 8 | `effective_until` boundary prevents invalid rollover -> `UNKNOWN` | **PASS** |
| 9 | Timezone-aware calculation works for non-UTC (`America/New_York`) | **PASS** |
| 10 | No hardcoded `+07` dependency (dynamically resolves time zone offsets) | **PASS** |
| 11 | Live fact still overrides recurring schedule | **PASS** |
| 12 | Expired live fact falls back to recurring schedule | **PASS** |
| 13 | Supplier isolation preserved (Hoàng Minh at Lào Cai remains `UNKNOWN`) | **PASS** |
| 14 | Recurring schedule still NEVER produces `AVAILABLE_NOW` | **PASS** |
| 15 | Recurring schedule still NEVER produces `FEASIBLE` | **PASS** |
| 16 | Production decisions unchanged (shadow candidate options only) | **PASS** |
| 17 | Telegram production decision flow remains untouched | **PASS** |
| 18 | No work orders created | **PASS** |
| 19 | Zero database mutation occurs during schedule rollover evaluation | **PASS** |

- **Total Test Suites Executed**: 20 files, 311 tests passing (`100% PASS`).

---

## 6. Post-Fix Natural Production Observation Evidence

- **OBSERVATION_TIME_UTC**: `2026-09-19T03:27:18.442Z`
- **OBSERVATION_TIME_ICT**: `2026-09-19T10:27:18+07:00`
- **POST_FIX_NATURAL_AFTER_WINDOW_OBSERVATION**: `ACTIVE` (`10:27:18 >= 10:00:00`)

### Post-Fix Evaluation Results:

| Warehouse | Supplier | Planned Count | Evaluated Status | Earliest Available At (Post-Fix) | Valid Until (Post-Fix) | Rollover Correct | Rollover Target Date |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Yên Bái** (`21161000`) | Hoàng Minh | 1 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` | `2026-09-20T10:00:00+07:00` | **YES** | `2026-09-20` |
| **Lào Cai** (`21158000`) | Thuận Phát | 2 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` | `2026-09-20T10:00:00+07:00` | **YES** | `2026-09-20` |
| **Phú Thọ** (`21160000`) | Thiên Phú | 5 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` | `2026-09-20T10:00:00+07:00` | **YES** | `2026-09-20` |
| **Phú Thọ** (`21160000`) | Hoàng Minh | 5 | `SCHEDULED_AVAILABLE` | `2026-09-20T07:00:00+07:00` | `2026-09-20T10:00:00+07:00` | **YES** | `2026-09-20` |
| **Lào Cai** (`21158000`) | Hoàng Minh (Ctrl) | 0 | `UNKNOWN` | `null` | `null` | **YES** | `N/A` |

- **HIGH_1_RESOLVED**: `YES`

---

## 7. Level C Invariant Verification

- **PRODUCTION_DECISION_CHANGED**: `NO`
- **TELEGRAM_CHANGED**: `NO`
- **WORK_ORDER_CREATED**: `NO`
- **SCHEDULE_ROWS_MUTATED**: `NO`
- **LIVE_FACT_INSERTED**: `NO`
- **RATE_CALCULATION_UNTOUCHED**: `YES` (no rate division by 30, no rate multiplication by count, no synthetic cost claims)
