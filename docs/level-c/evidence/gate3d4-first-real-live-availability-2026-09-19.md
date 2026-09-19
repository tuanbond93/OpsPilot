# OpsPilot Level C — Gate 3D.4 Evidence Lock & Remediation Phase 1
**Secure Deployment & Negative Authentication Verification**

- **Gate**: `GATE_3D.4_FIRST_REAL_LIVE_VEHICLE_AVAILABILITY_FACT`
- **Phase**: `PHASE_1_SECURE_DEPLOYMENT_AND_EVIDENCE_CORRECTION`
- **Timestamp (ICT)**: `2026-09-19T11:42:00+07:00`
- **Gate Evidence Status**: `NOT_PROVEN_PENDING_REAL_AUTHENTICATED_WRITE`
- **084 SQL Script Executed**: `NO` (Remains strictly unexecuted reference artifact)
- **Live Facts Written in Phase 1**: `0`

---

## 1. Canonical Production Deployment State

- **Canonical URL**: `https://opspilot-tau-lyart.vercel.app`
- **Production Deployment ID**: `dpl_7zonurB8GUDD96JYbRq9YmSgWzjW`
- **Deployed Commit**: `cd387db` (`fix(level-c): correct gate 3d.4 ground truth, negative control semantics, and add bearer security tests`)
- **Git Head**: `cd387db`
- **Production Health Status**: `GREEN` (Checked at `2026-09-19T04:41:49.394Z` — `realtime: GREEN`, `scheduler: GREEN`, `aiprovider: GREEN`, `rillnet: GREEN`, `database: GREEN`, `telegram: GREEN`)

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

## 4. Owner-Confirmed Operational Parameters & Validity Status

Evaluation at current time (`11:42 ICT`):

| # | Warehouse ID | Warehouse | Supplier | Vehicle Class | Count | Earliest Available (ICT) | Valid Until (ICT) | Still Within Validity |
| :-: | :--- | :--- | :--- | :---: | :-: | :---: | :---: | :---: |
| 1 | `21161000` | Yên Bái | Hoàng Minh | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | **YES** (`11:42 < 12:00`) |
| 2 | `21158000` | Lào Cai | Thuận Phát | `TRUCK_1_9T` | 1 | `2026-09-19T07:00:00+07:00` | `2026-09-19T12:00:00+07:00` | **YES** (`11:42 < 12:00`) |
| 3 | `21160000` | Phú Thọ | Thiên Phú | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | **YES** (`11:42 < 14:00`) |
| 4 | `21160000` | Phú Thọ | Hoàng Minh | `TRUCK_1_9T` | 2 | `2026-09-19T07:00:00+07:00` | `2026-09-19T14:00:00+07:00` | **YES** (`11:42 < 14:00`) |
| 5 | `21158000` | Lào Cai | Hoàng Minh | `TRUCK_1_9T` | **NULL** | — | — | **NEGATIVE CONTROL** |

---

## 5. Corrected Negative Control Semantics (`UNKNOWN != ZERO`)

- `availability_status` = `UNKNOWN`
- `available_count` = `UNKNOWN / NULL` (NOT 0)
- `capacity_kg` = `UNKNOWN / NULL` (NOT 0)

Reporting `0` for unobserved availability conflates absence of data with a positive observation of zero availability (`UNAVAILABLE`), and has been corrected.

---

## 6. Safety Invariants Summary

- `PRODUCTION_DECISION_CHANGED`: **MUST_BE_NO** (Verified: NO)
- `TELEGRAM_ACTION_SENT`: **MUST_BE_NO** (Verified: NO)
- `WORK_ORDER_CREATED`: **MUST_BE_NO** (Verified: NO)
- `AUTONOMOUS_DISPATCH`: **MUST_BE_NO** (Verified: NO)
- `084_EXECUTED`: **MUST_BE_NO** (Verified: NO)
- `LIVE_FACTS_WRITTEN_IN_PHASE_1`: **MUST_BE_0** (Verified: 0)
- `GATE_3D4_STATUS`: **NOT_PROVEN_PENDING_REAL_AUTHENTICATED_WRITE**
