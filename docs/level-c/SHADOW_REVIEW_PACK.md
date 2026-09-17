# Near-Term Capacity Policy B Shadow — Manager Review Pack

> [!NOTE]
> This review pack contains the measured historical replay outcomes for all 21 Policy B candidate cases across 21 warehouses.
> Evaluated via Gemini Free Tier (`gemini-flash-lite-latest`) with deterministic Critic validation and outcome backtesting against subsequent incident history.

## Replay Summary Statistics

| Metric | Measured Value |
|---|---|
| Total Historical Candidates Evaluated | 21 |
| AI Generation Success Rate | 100% (21/21) |
| AI Generation Failure Rate | 0% (0/21) |
| Deterministic Critic Pass Rate | 100% (21/21) |
| Deterministic Critic Rejection Rate | 0% (0/21) |
| Warehouses Covered | 21 distinct warehouses |
| Unknown Fact Rate (`current_kg = null`) | 100.0% (21/21 preserved UNKNOWN != ZERO) |
| Action Distribution | 100% NO_ACTION_MONITOR (21/21) |
| Provisional Signal Quality Labels | 66.7% MONITOR_ONLY (14), 33.3% LIKELY_NOISE (7) |
| Outcome Backtest Consistency | 100% CONSISTENT_WITH_OUTCOME (21/21) |
| Old Simulated Signal Quality Valid? | NO (Simulated 45% clearly actionable was unmeasured) |

## Sample Evaluation Cohorts

### Cohort 1: Representative Candidates (High Backlog & Monitor)

| Shadow ID | Warehouse | Orders | Kg Status | Recommendation | Confidence | Critic | Outcome Backtest | Provisional Label | Review Required |
|---|---|---|---|---|---|---|---|---|---|
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - TP Hạ Long - Quảng Ninh | 44 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **MONITOR_ONLY** | YES |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Mỹ Lộc - Nam Định | 25 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **MONITOR_ONLY** | YES |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Thủ Đức - HCM | 18 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **MONITOR_ONLY** | YES |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Đông Hưng - Thái Bình | 62 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **MONITOR_ONLY** | YES |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Nho Quan - Ninh Bình | 23 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **MONITOR_ONLY** | YES |

### Cohort 2: Low Backlog Candidates (Likely Noise)

| Shadow ID | Warehouse | Orders | Kg Status | Recommendation | Confidence | Critic | Outcome Backtest | Provisional Label | Review Required |
|---|---|---|---|---|---|---|---|---|---|
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Bến Cát - Bình Dương | 5 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **LIKELY_NOISE** | NO |
| `shadow-5ed84251-b5d6-4e5...` | Kho Trung Chuyển Đà Nẵng | 9 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **LIKELY_NOISE** | NO |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Độc Lập - HCM | 8 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **LIKELY_NOISE** | NO |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Tuy Phong - Bình Thuận | 2 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **LIKELY_NOISE** | NO |
| `shadow-5ed84251-b5d6-4e5...` | Kho Giao Hàng Nặng - Liên Chiểu - Đà Nẵng | 7 | UNKNOWN | `NO_ACTION_MONITOR` | 0.85 | VALID_DECISION | CONSISTENT_WITH_OUTCOME | **LIKELY_NOISE** | NO |

## Full Case-by-Case Breakdown (21 Replayed Cases)

### Case #1: Kho Giao Hàng Nặng - TP Hạ Long - Quảng Ninh

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21153000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21153000:KHO_TON`
- **Warehouse ID**: `21153000` (Quảng Ninh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 44 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại là 44 đơn nhưng dữ liệu khối lượng chưa có sẵn (UNKNOWN), do đó không đủ căn cứ để triển khai các biện pháp tăng cường phương tiện hay nhân sự. Cần tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 44 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #2: Kho Giao Hàng Nặng - Bến Cát - Bình Dương

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22855000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22855000:KHO_TON`
- **Warehouse ID**: `22855000` (Bình Dương)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 5 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho thấp (5 đơn) và dữ liệu khối lượng chưa xác định, không cần can thiệp khẩn cấp nhưng cần tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (5 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #3: Kho Giao Hàng Nặng - Mỹ Lộc - Nam Định

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21154000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21154000:KHO_TON`
- **Warehouse ID**: `21154000` (Nam Định)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 25 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại thấp (25 đơn) nhưng thiếu dữ liệu khối lượng, cần tiếp tục giám sát tình hình vận hành tại kho."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 25 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #4: Kho Giao Hàng Nặng - Thủ Đức - HCM

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21463000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21463000:KHO_TON`
- **Warehouse ID**: `21463000` (Hồ Chí Minh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 18 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại ở mức thấp (18 đơn) nhưng thiếu dữ liệu khối lượng chi tiết, chưa đủ cơ sở để thực hiện can thiệp mạnh; tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 18 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #5: Kho Giao Hàng Nặng - Đông Hưng - Thái Bình

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21155000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21155000:KHO_TON`
- **Warehouse ID**: `21155000` (Thái Bình)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 62 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại ở mức 62 đơn nhưng thiếu dữ liệu về khối lượng (kg), không đủ cơ sở để thực hiện các can thiệp vận hành đòi hỏi tải trọng chính xác; do đó cần tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 62 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #6: Kho Giao Hàng Nặng - Nho Quan - Ninh Bình

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21151000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21151000:KHO_TON`
- **Warehouse ID**: `21151000` (Ninh Bình)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 23 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại ở mức thấp (23 đơn) nhưng thiếu dữ liệu khối lượng chi tiết, chưa cần can thiệp khẩn cấp mà cần tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 23 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #7: Kho B2B - Đài Tư - Hà Nội

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22328000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22328000:KHO_TON`
- **Warehouse ID**: `22328000` (Hà Nội)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 172 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng đơn hàng hiện tại chưa có dữ liệu cụ thể, cần tiếp tục theo dõi sát sao tình hình tồn kho tại kho B2B Đài Tư."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 172 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #8: Kho Giao Hàng Nặng - Tân Thuận - HCM

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22957000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22957000:KHO_TON`
- **Warehouse ID**: `22957000` (Hồ Chí Minh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 23 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại ở mức thấp (23 đơn) nhưng thiếu dữ liệu trọng lượng khối lượng, cần tiếp tục theo dõi sát sao mà chưa cần can thiệp tốn kém."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 23 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #9: Kho Giao Hàng Nặng - TP Bà Rịa - BRVT

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22112000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22112000:KHO_TON`
- **Warehouse ID**: `22112000` (Bà Rịa - Vũng Tàu)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 10 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại thấp (10 đơn) nhưng thiếu dữ liệu khối lượng, chưa đủ cơ sở thực hiện can thiệp mạnh nên tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 10 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #10: Kho Giao Hàng Nặng - Việt Yên - Bắc Giang

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21152000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21152000:KHO_TON`
- **Warehouse ID**: `21152000` (Bắc Giang)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 47 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại là 47 đơn, tuy nhiên dữ liệu khối lượng đang trống nên cần tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 47 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #11: Kho Trung Chuyển Đà Nẵng

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_1141_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:1141:KHO_TON`
- **Warehouse ID**: `1141` (Đà Nẵng)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 9 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng hàng tồn kho chưa có dữ liệu chính xác, chỉ ghi nhận 9 đơn hàng nên cần tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (9 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #12: Kho Giao Hàng Nặng - Tân Bình - HCM

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21712000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21712000:KHO_TON`
- **Warehouse ID**: `21712000` (Hồ Chí Minh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 22 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho ở mức thấp (22 đơn) nhưng thiếu dữ liệu về khối lượng, chưa cần can thiệp khẩn cấp mà cần tiếp tục giám sát."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 22 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #13: Kho Giao Hàng Nặng - Tân Bình - Hải Dương

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21337000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21337000:KHO_TON`
- **Warehouse ID**: `21337000` (Hải Dương)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 57 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng đơn hàng hiện tại chưa có dữ liệu chính xác, cần tiếp tục theo dõi tình hình tồn kho tại kho Tân Bình - Hải Dương."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 57 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #14: Kho Giao Hàng Nặng - Độc Lập - HCM

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22995000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22995000:KHO_TON`
- **Warehouse ID**: `22995000` (Hồ Chí Minh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 8 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho ở mức thấp (8 đơn) nhưng thiếu dữ liệu về khối lượng (kg), do đó chưa đủ cơ sở để thực hiện các biện pháp can thiệp vận hành như điều động xe hay nhân sự."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (8 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #15: Kho Giao Hàng Nặng - TP Tây Ninh - Tây Ninh

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22160000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22160000:KHO_TON`
- **Warehouse ID**: `22160000` (Tây Ninh)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 16 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng đơn hàng hiện tại chưa có dữ liệu (UNKNOWN), chỉ có 16 đơn hàng tồn. Do thiếu dữ liệu trọng tải quan trọng, hệ thống khuyến nghị tiếp tục giám sát và không can thiệp vội."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 16 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #16: Kho Giao Hàng Nặng - Tuy Phong - Bình Thuận

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22057000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22057000:KHO_TON`
- **Warehouse ID**: `22057000` (Bình Thuận)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 2 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng hàng hóa chưa có dữ liệu và lượng tồn kho thấp (2 đơn), cần tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (2 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #17: Kho Giao Hàng Nặng - Liên Chiểu - Đà Nẵng

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21089000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21089000:KHO_TON`
- **Warehouse ID**: `21089000` (Đà Nẵng)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 7 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Khối lượng đơn hàng hiện tại chưa có dữ liệu và số lượng tồn kho thấp (7 đơn), cần tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (7 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #18: Kho Giao Hàng Nặng - TP Đà Lạt - Lâm Đồng

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_21130000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:21130000:KHO_TON`
- **Warehouse ID**: `21130000` (Lâm Đồng)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 10 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho ở mức thấp (10 đơn) nhưng thiếu dữ liệu trọng lượng (currentKg), cần tiếp tục theo dõi sát sao."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 10 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #19: (HNO) LH Long Biên

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_23013000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:23013000:KHO_TON`
- **Warehouse ID**: `23013000` (Hà Nội)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 90 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại là 90 đơn nhưng chưa có dữ liệu về khối lượng (currentKg là null), do đó chưa đủ cơ sở để thực hiện can thiệp cấu trúc. Cần tiếp tục giám sát."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 1 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`MONITOR_ONLY`** — Justification: Backlog of 90 orders deemed manageable by standard shift operations without escalation.
- **Human Review Required**: YES

---

### Case #20: (LDO) Xuân Trường - Đà Lạt

- **Shadow ID**: `shadow-5ed84251-b5d6-4e54-bff8-c5872cd5b901_22116000_KHO_TON`
- **Source Candidate ID**: `5ed84251-b5d6-4e54-bff8-c5872cd5b901:22116000:KHO_TON`
- **Warehouse ID**: `22116000` (Lâm Đồng)
- **Observed At**: `2026-09-16T01:00:00+00:00`
- **Risk Facts**: Backlog orders = 1 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại rất thấp (1 đơn hàng) và thiếu dữ liệu khối lượng chi tiết, do đó chưa cần can thiệp vận hành ngay lập tức mà tiếp tục theo dõi."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Incident naturally resolved without physical intervention, matching NO_ACTION_MONITOR recommendation.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (1 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

### Case #21: Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái

- **Shadow ID**: `shadow-a18390c6-6ec4-4930-94b4-31269efacc9c_21161000_KHO_TON`
- **Source Candidate ID**: `a18390c6-6ec4-4930-94b4-31269efacc9c:21161000:KHO_TON`
- **Warehouse ID**: `21161000` (Yên Bái)
- **Observed At**: `2026-09-16T03:00:00+00:00`
- **Risk Facts**: Backlog orders = 6 (AVAILABLE)
- **Missing Facts**: Weight = null (UNKNOWN != ZERO preserved)
- **AI Recommendation**: `NO_ACTION_MONITOR` (Confidence: 0.85)
- **AI Reason Summary**: "Tồn kho hiện tại ở mức thấp (6 đơn), chưa có dữ liệu khối lượng chi tiết để thực hiện các can thiệp sâu hơn. Đề xuất tiếp tục giám sát."
- **Critic Result**: `VALID_DECISION` (Flags: None)
- **Historical Outcome Backtest**: `CONSISTENT_WITH_OUTCOME` — Subsequent order count recorded at 17 orders; operational trend consistent with managed backlog.
- **Provisional Label**: **`LIKELY_NOISE`** — Justification: Small backlog (6 orders) below significant operational stress; passive monitoring recommended.
- **Human Review Required**: NO

---

