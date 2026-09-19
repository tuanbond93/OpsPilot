# OpsPilot Level C — Gate 3D.4 Evidence Lock & Remediation
**Phase 2A — Manager Vehicle Availability Confirmation UI Deployment**

- **Gate**: `GATE_3D.4_FIRST_REAL_LIVE_VEHICLE_AVAILABILITY_FACT`
- **Phase**: `PHASE_2A_MANAGER_VEHICLE_AVAILABILITY_CONFIRMATION_UI`
- **Timestamp (ICT)**: `2026-09-19T15:32:00+07:00`
- **Gate Evidence Status**: `NOT_PROVEN_PENDING_REAL_AUTHENTICATED_MANAGER_WRITE`
- **084 SQL Script Executed**: `NO` (Strictly unexecuted reference artifact)
- **Live Facts Written in Phase 2A**: `0`

---

## 1. Canonical Production Deployment State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Manager Confirmation UI Route**: `https://opspilot-tau-lyart.vercel.app/operations/vehicle-availability`
- **Production Deployment ID**: `dpl_GWBDa9Dpr1VUzFZkoxgDFtq3ecsp`
- **Deployed Commit**: `3c49df2` (`feat(level-c): add manager vehicle availability confirmation UI and tests`)
- **Git Head**: `3c49df2`
- **Production Health Status**: `GREEN` (Checked at `2026-09-19T08:31:42.836Z` — `realtime: GREEN`, `scheduler: GREEN`, `aiprovider: GREEN`, `rillnet: GREEN`, `database: GREEN`, `telegram: GREEN`)

---

## 2. Production Negative Authentication Probes

Executed directly against canonical route `/api/internal/governed-sources/vehicle-availability` with non-mutating payloads:

| Probe Type | Request Header | HTTP Status | Response Payload | Result |
| :--- | :--- | :---: | :--- | :---: |
| **NO_AUTH** | *(None)* | **401** | `{"error":"AUTHENTICATION_REQUIRED"}` | **BLOCKED** |
| **RANDOM_BEARER** | `Authorization: Bearer random_untrusted_bearer_token_xyz_999` | **401** | `{"error":"AUTHENTICATION_REQUIRED"}` | **BLOCKED** |
| **MALFORMED_BEARER** | `Authorization: Bearer not-a-jwt.malformed.probe` | **401** | `{"error":"AUTHENTICATION_REQUIRED"}` | **BLOCKED** |

Zero rows were written during these probes (`LIVE_FACTS_WRITTEN_THIS_PHASE = 0`).

---

## 3. Local Security Verification (8/8 Passed)

File: `src/__tests__/api-bearer-security-negative.test.ts`

- `NO_AUTH`: Rejected with 401 `AUTHENTICATION_REQUIRED`.
- `RANDOM_BEARER`: Rejected with 401 `AUTHENTICATION_REQUIRED`.
- `MALFORMED_BEARER`: Rejected with 401 `AUTHENTICATION_REQUIRED`.
- `EXPIRED_TOKEN`: Rejected with 401 `AUTHENTICATION_REQUIRED`.
- `LOW_PRIVILEGE_VALID_USER`: Valid user with `VIEWER` role rejected with 403 `PERMISSION_DENIED`.
- `BODY_ROLE_SPOOF`: Request body self-promotion blocked with 403 `ROLE_MISMATCH`.
- `SERVICE_CREDENTIAL_AS_MANAGER`: Service credential (`CRON_SECRET`) masquerading as human Telegram manager blocked with 403 `FORBIDDEN_IMPERSONATION`.
- `VALID_MANAGER`: Valid `OPERATIONS_MANAGER` token authorized with server-derived identity.

---

## 3.1 Phase 2A Manager Confirmation UI Verification (20/20 Passed)

File: `src/__tests__/manager-vehicle-availability-ui.test.ts`

- **Criterion 1**: Denies access when session is unauthenticated or missing roles.
- **Criterion 2**: Denies access to insufficient roles (VIEWER, OPERATOR, MEMBER).
- **Criterion 3**: Grants access to authorized managers (OPERATIONS_MANAGER, MANAGER, ADMIN, DISPATCH_MANAGER).
- **Criterion 4**: Enforces positive integer count (rejects 0, -1, floats, non-numeric).
- **Criterion 5**: Blocks valid_until in the past or equal to current evaluation time.
- **Criterion 6**: Blocks valid_until earlier than earliest_available_at.
- **Criterion 7**: Accepts valid future inputs with authorized pilot warehouse and supplier.
- **Criterion 8**: Authentication token is never accepted or returned in UI logic or formatters.
- **Criterion 9**: Actor role is not controlled by form input or submission payload.
- **Criterion 10**: Actor identity is not controlled by form input or submission payload.
- **Criterion 11**: Submission target route is internal and same-origin relative (`/api/internal/governed-sources/vehicle-availability`).
- **Criterion 12**: Capacity preview calculates 1 vehicle = 1,600 kg usable payload.
- **Criterion 13**: Capacity preview calculates 2 vehicles = 3,200 kg usable payload.
- **Criterion 14**: Enforces UNKNOWN != ZERO semantics: missing available_count renders as UNKNOWN / NULL, not 0 xe or 0 kg.
- **Criterion 15**: Displays expired facts as EXPIRED and never as AVAILABLE_NOW.
- **Criterion 16**: Formats sanitized confirmation upon successful persistence.
- **Criterion 17**: No commercial rates or prices displayed in preview or confirmations.
- **Criterion 18**: Disclaimer explicitly clarifies no SLA commitment.
- **Criterion 19**: Disclaimer explicitly clarifies no cost saving estimation.
- **Criterion 20**: Automated test creates ZERO production database records or API writes.

---

## 4. Historical Owner-Confirmed Parameters & Expiry Status

Evaluation at current time (`15:32 ICT`):

| # | Warehouse ID | Warehouse | Supplier | Vehicle Class | Count | Earliest Available (ICT) | Valid Until (ICT) | Current Status |
| :-: | :--- | :--- | :--- | :---: | :-: | :---: | :---: | :---: |
| 1 | `21161000` | Yên Bái | Hoàng Minh | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | **EXPIRED** (`15:32 > 12:00`) |
| 2 | `21158000` | Lào Cai | Thuận Phát | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | **EXPIRED** (`15:32 > 12:00`) |
| 3 | `21160000` | Phú Thọ | Thiên Phú | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | **EXPIRED** (`15:32 > 14:00`) |
| 4 | `21160000` | Phú Thọ | Hoàng Minh | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | **EXPIRED** (`15:32 > 14:00`) |
| 5 | `21158000` | Lào Cai | Hoàng Minh | `TRUCK_1_9T` | **NULL** | — | — | **NEGATIVE CONTROL** (`UNKNOWN != ZERO`) |

*All morning facts have naturally expired. No expired facts may be submitted or backdated. New facts must specify future valid_until.*

---

## 5. Corrected Negative Control Semantics (`UNKNOWN != ZERO`)

- `availability_status` = `UNKNOWN`
- `available_count` = `UNKNOWN / NULL` (NOT 0)
- `capacity_kg` = `UNKNOWN / NULL` (NOT 0)

Reporting `0` for unobserved availability conflates absence of data with a positive observation of zero availability (`UNAVAILABLE`), and has been corrected.

---

## 3.2 Phase 2B Atomic Fact Supersession Verification (17/17 Passed)

File: `src/__tests__/manager-vehicle-supersession.test.ts`
Migration: `src/database/migrations/085_vehicle_fleet_availability_supersession.sql`

- **Criterion 1**: First fact becomes the single current assertion (`superseded_at IS NULL`).
- **Criterion 2**: Second fact for same `(warehouse, supplier, vehicle_class)` atomically supersedes the first.
- **Criterion 3**: Old fact retains its original `valid_until` unchanged (no TTL truncation/loss of audit history).
- **Criterion 4**: Old fact has `superseded_at` stamped to new fact's `captured_at`.
- **Criterion 5**: Old fact points forward to replacement via `superseded_by = new_id`.
- **Criterion 6**: New fact points back to replaced fact via `supersedes_fact_id = old_id`.
- **Criterion 7**: Active query returns exactly one row for the tuple.
- **Criterion 8**: Near-term capacity evaluator selects the newer unexpired fact over the superseded one.
- **Criterion 9**: Engine adapter enforces deterministic latest-wins: older unexpired facts never overwrite newer facts.
- **Criterion 10**: Corrected fact replaces capacity rather than aggregating (2 vehicles = 3,200 kg, never 1 + 2 = 4,800 kg).
- **Criterion 11**: When a current fact expires naturally, engine falls back to recurring schedule.
- **Criterion 12**: Superseded historical fact is never reactivated even after replacement fact expires.
- **Criterion 13**: Transaction failure rolls back cleanly without marking old fact superseded.
- **Criterion 14**: Concurrent writes cannot produce multiple current facts (enforced by partial unique index `uq_fleet_avail_single_current`).
- **Criterion 15**: Different suppliers at the same warehouse remain strictly isolated.
- **Criterion 16**: Different warehouses for the same supplier remain strictly isolated.
- **Criterion 17**: Semantic invariant `UNKNOWN != ZERO` preserved across supersession states.

---

## 4. Production Erroneous Fact & Post-Deployment Human Correction

### 4.1 Erroneous Fact Submitted in Pilot (Pre-Correction State)
During initial testing via the Manager UI, one real fact was submitted with erroneous values:
- **Warehouse**: `21160000` (Phú Thọ)
- **Supplier**: Thiên Phú
- **Vehicle Class**: `TRUCK_1_9T`
- **Available Count**: `1` (ERRONEOUS — should be 2)
- **Capacity**: 1,600 kg (ERRONEOUS — should be 3,200 kg)
- **Valid Until**: `2026-09-19T17:00:00+07:00`
- **Status**: `AVAILABLE_NOW` (until 17:00 ICT)

### 4.2 Authorized Target Values for Operations Manager Correction
The Operations Manager has confirmed the corrected values to be submitted manually via UI:
- **Warehouse**: `21160000` (Phú Thọ)
- **Supplier**: Thiên Phú
- **Vehicle Class**: `TRUCK_1_9T`
- **Available Count**: `2`
- **Earliest Available**: `2026-09-19T15:15:00+07:00`
- **Valid Until**: `2026-09-19T18:00:00+07:00`
- **Expected Capacity**: `3,200 kg`

*Note: The erroneous 1-vehicle row was NOT mutated or corrected during this engineering task. The human Operations Manager will execute the correction via `/operations/vehicle-availability` post-deployment.*

---

## 5. Safety Invariants Summary

- `PRODUCTION_DECISION_CHANGED`: **MUST_BE_NO** (Verified: NO)
- `TELEGRAM_ACTION_SENT`: **MUST_BE_NO** (Verified: NO)
- `WORK_ORDER_CREATED`: **MUST_BE_NO** (Verified: NO)
- `AUTONOMOUS_DISPATCH`: **MUST_BE_NO** (Verified: NO)
- `084_EXECUTED`: **MUST_BE_NO** (Verified: NO)
- `AUTOMATIC_PRODUCTION_MUTATION_DURING_TASK`: **MUST_BE_0** (Verified: 0)
- `GATE_3D4_STATUS`: **NOT_PROVEN_PENDING_DIRECT_OWNER_CORRECTION_WRITE**

