# OpsPilot Level C — Gate 3D.4 Evidence Lock & Audit Reconciliation
**First Real Live Vehicle Availability Facts & Governance Invariant Verification**

- **Gate**: `GATE_3D.4_FIRST_REAL_LIVE_VEHICLE_AVAILABILITY_FACT`
- **Reconciliation Audit Time (ICT)**: `2026-09-19T11:35:37+07:00`
- **Confirmation Time / Authorized Window (ICT)**: `2026-09-19T11:13:40+07:00`
- **Gate Evidence Status**: `NOT_PROVEN_PENDING_REAL_AUTHENTICATED_WRITE`
- **Database Script 084 Executed**: `NO` (Remains unexecuted reference artifact)
- **Production Live Facts Persisted**: `0` (Zero rows written to production database)

---

## 1. Production State Reconciliation Audit

Audit of previous session actions identified discrepancies between test execution and actual production mutations:

| Audit Item | Previous Claim | Reconciled Audit Ground Truth | Status |
| :--- | :--- | :--- | :---: |
| **084 SQL Script** | Created | Created locally at `084_...sql`, but **NEVER executed** against production Supabase DB | **UNEXECUTED** |
| **Production Posts** | Persisted | **0 HTTP POSTs** dispatched to `/api/internal/governed-sources/vehicle-availability` | **0 POSTS** |
| **Production Rows** | 4 rows written | **0 rows** written to `public.vehicle_fleet_availability` in production | **0 ROWS** |
| **Deployed Commit** | `695b732` | Canonical production serves `015c7cd`; `695b732` is HEAD on branch but was not deployed | **NOT DEPLOYED** |
| **Negative Control** | `count: 0, 0 kg` | **SEMANTIC BUG**: `UNKNOWN` signifies absence of data (`count: NULL / UNKNOWN`, `capacity: NULL / UNKNOWN`), not positive zero | **CORRECTED** |
| **Gate 3D.4 Status** | `PASS` | Prematurely declared on test execution alone; correct status is **NOT_PROVEN** | **CORRECTED** |

---

## 2. Owner-Confirmed Operational Parameters (Explicit `valid_until`)

The Operations Manager directly confirmed the vehicle availability facts and explicit non-fabricated validity windows:

| # | Warehouse ID | Warehouse | Supplier | Vehicle Class | Count | Earliest Available (ICT) | Valid Until (ICT) | Confirmation Source |
| :-: | :--- | :--- | :--- | :---: | :-: | :---: | :---: | :--- |
| 1 | `21161000` | Yên Bái | Hoàng Minh | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 2 | `21158000` | Lào Cai | Thuận Phát | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 3 | `21160000` | Phú Thọ | Thiên Phú | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 4 | `21160000` | Phú Thọ | Hoàng Minh | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | `OPERATIONS_MANAGER_DIRECT_CONFIRMATION` |
| 5 | `21158000` | Lào Cai | Hoàng Minh | `TRUCK_1_9T` | **NULL** | — | — | **NEGATIVE CONTROL (NO ROW)** |

---

## 3. Corrected Negative Control Semantics (`UNKNOWN != ZERO`)

In the domain and evaluation engine:
- **`UNAVAILABLE`**: Positive governed observation that zero vehicles are available (`available_count = 0`, `capacity_kg = 0`).
- **`UNKNOWN`**: Complete absence of fresh facts or recurring schedules.
- **Correction Applied**:
  - `availability_status` = `UNKNOWN`
  - `available_count` = `UNKNOWN / NULL` (NOT 0)
  - `capacity_kg` = `UNKNOWN / NULL` (NOT 0)

Reporting `count: 0` or `capacity: 0` for `UNKNOWN` was an epistemic bug and is now formally resolved in all artifacts.

---

## 4. Pre-Write Safety & Validity Window Verification

Evaluation at current time (`11:35:37 ICT`):
1. **Yên Bái / Hoàng Minh**: `11:35:37 < 12:00:00` -> **STILL WITHIN VALIDITY**
2. **Lào Cai / Thuận Phát**: `11:35:37 < 12:00:00` -> **STILL WITHIN VALIDITY**
3. **Phú Thọ / Thiên Phú**: `11:35:37 < 14:00:00` -> **STILL WITHIN VALIDITY**
4. **Phú Thọ / Hoàng Minh**: `11:35:37 < 14:00:00` -> **STILL WITHIN VALIDITY**

*Governance Invariant*: If any fact reaches its `valid_until` before write execution, it must be marked `SKIPPED_EXPIRED_BEFORE_WRITE` and not written. Validity timestamps will never be artificially extended.

---

## 5. Security Review: Authenticated Manager Write Path

Bearer token authentication mechanism in `src/security/api-security.ts` and `src/domain/near-term-capacity/multi-option/sources/vehicle-availability-service.ts` audited:

| # | Security Requirement | Implementation Mechanism | Local Negative Test Status |
| :-: | :--- | :--- | :---: |
| A | Cryptographic Token Validation | `supabase.auth.getUser(bearerToken)` contacts Supabase Auth API | **PASS** |
| B | Server-Side Identity Derivation | Principal `id` and `actor` derived from `data.user` (not request body) | **PASS** |
| C | Server-Side Role Derivation | Role extracted from `app_metadata` / `user_metadata` and mapped via `roleFromMetadata` | **PASS** |
| D | Body Actor Spoofing Blocked | `finalSuppliedBy = principal.actor \|\| user:${principal.userId}` | **PASS** |
| E | Body Role Self-Promotion Blocked | Returns HTTP 403 `ROLE_MISMATCH` if body role differs from derived role | **PASS** |
| F | Service Credential Cannot Impersonate | `CRON_SECRET` cannot claim human Telegram actor (HTTP 403 `FORBIDDEN_IMPERSONATION`) | **PASS** |
| G | Arbitrary / Random Bearer Rejected | Supabase Auth API returns error -> HTTP 401 `AUTHENTICATION_REQUIRED` | **PASS** |
| H | Malformed Bearer Rejected | Non-JWT bearer string rejected with HTTP 401 `AUTHENTICATION_REQUIRED` | **PASS** |
| I | Expired Bearer Rejected | Expired JWT rejected with HTTP 401 `AUTHENTICATION_REQUIRED` | **PASS** |
| J | Low-Privilege Valid User Rejected | Valid user with role `VIEWER`/`OPERATOR` rejected with HTTP 403 `PERMISSION_DENIED` | **PASS** |
| K | Valid Manager Authorized | Valid user with role `MANAGER`/`OPERATIONS_MANAGER` authorized with server identity | **PASS** |

Dedicated test file: [`src/__tests__/api-bearer-security-negative.test.ts`](file:///d:/Project/OpsPilot/src/__tests__/api-bearer-security-negative.test.ts) (8/8 tests passed).

---

## 6. Unit & Integration Test Evidence (Local Test Environment Only)

File: `src/__tests__/near-term-capacity-gate3d4.test.ts` (26/26 passed)

- Fresh positive live facts evaluate to `AVAILABLE_NOW` in adapter memory.
- Live facts override recurring schedule evidence in adapter memory.
- Usable payload correctly calculated: 1 vehicle = 1,600 kg; 2 vehicles = 3,200 kg.
- Negative control `Lào Cai / Hoàng Minh` evaluates to `UNKNOWN` (`available_count: undefined`, `capacity: null`).
- Expiry timeline transitions verified: 11:15 ICT (`AVAILABLE_NOW`) -> 12:00:01 ICT (fallback to tomorrow schedule) -> 14:00:01 ICT (fallback to tomorrow schedule).
- Multi-option shadow evaluation sets vehicle availability to `FEASIBLE` while overall option feasibility remains `CONDITIONALLY_FEASIBLE` and recommendation remains `REQUEST_MORE_INFORMATION`.

*Note: The above reflects unit/integration test simulation in Vitest. It does not constitute live production database evidence.*

---

## 7. Production Evidence State (Phase 1 Ground Truth)

- **Production URL**: `https://opspilot-tau-lyart.vercel.app`
- **Canonical Serving Commit**: `015c7cd` (Gate 3D.3B)
- **Live Fact Rows in Production DB**: **0**
- **Facts Written in Phase 1**: **0**
- **084 Migration Executed**: **NO**
- **Production Decisions Mutated**: **NO**
- **Telegram Dispatches**: **NO**
- **Work Orders Created**: **NO**
- **Autonomous Dispatch**: **NO**

---

## 8. Safety Invariants Summary

- `PRODUCTION_DECISION_CHANGED`: **MUST_BE_NO** (Verified: NO)
- `TELEGRAM_ACTION_SENT`: **MUST_BE_NO** (Verified: NO)
- `WORK_ORDER_CREATED`: **MUST_BE_NO** (Verified: NO)
- `AUTONOMOUS_DISPATCH`: **MUST_BE_NO** (Verified: NO)
- `084_EXECUTED`: **MUST_BE_NO** (Verified: NO)
- `LIVE_FACTS_WRITTEN_IN_PHASE_1`: **MUST_BE_0** (Verified: 0)
- `GATE_3D4_STATUS`: **NOT_PROVEN_PENDING_REAL_AUTHENTICATED_WRITE**
