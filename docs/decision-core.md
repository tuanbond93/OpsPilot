# Decision Core

Decision Core là boundary độc lập giữa operational evidence/recommendation và execution. Nó tham chiếu Incident, Root Cause context, Follow-up, Planner và Action identifiers nhưng không tự thực thi Action.

## Lifecycle

```text
DRAFT → READY_FOR_REVIEW → APPROVED | REJECTED
                         → EXECUTED → OUTCOME_PENDING
                                      → SUCCESS | FAILURE | INCONCLUSIVE
```

`SHADOW` có thể lưu observed outcome để so sánh với vận hành thực tế nhưng không có approve/reject/execute control. `AUTONOMOUS` luôn bị chặn ở validation, service và database RPC.

## Local pilot

Local development mặc định dùng mock Decision repository để Inbox không phụ thuộc kết nối Supabase. Để chạy qua Supabase explicitly:

```text
DECISION_PERSISTENCE=supabase
```

Production luôn dùng Supabase và yêu cầu `ENABLE_DASHBOARD_WRITE_CONTROLS=true` cho write operations.

Pilot endpoint:

```text
POST /api/decisions/from-incident/:incidentId
{ "actor": "pilot-operator", "idempotencyKey": "optional-stable-key" }
```

Endpoint này chỉ tạo recommendation/evidence snapshot ở `SHADOW`; không enqueue notification và không gọi execution.

## LC-01 final decision boundary

`DecisionPilotService` không còn mặc định lấy recommendation đầu tiên. Nó đưa các candidate từ Planner qua deterministic Final Decision Engine (`lc01-v1`) để tạo đúng một trong hai disposition:

- `DECIDE`: chọn một option bằng ranking ổn định dựa trên priority, operational risk, evidence và prerequisite data.
- `HUMAN_INVESTIGATION_REQUIRED`: không có candidate đủ điều kiện; lưu yêu cầu điều tra thay vì giả tạo một quyết định.

Snapshot lưu selected option, rationale, expected operational outcome, limitations, evidence refs và provenance. Final Decision Engine không tự thực thi action và không tính financial impact.

## LC-02 decision critic boundary

Final Decision được review độc lập bởi deterministic Decision Critic (`lc02-v1`) trước khi tạo Decision snapshot. Critic kiểm tra selected option, action/rationale, evidence, confidence threshold theo operational risk và prerequisite chưa giải quyết.

- `PASS`: giữ final decision để quan sát/phê duyệt theo mode.
- `HUMAN_INVESTIGATION_REQUIRED`: bỏ selected option khỏi recommendation được trình bày, không đưa alternatives và thay bằng yêu cầu xác minh evidence/prerequisite.

Critic không chọn option thay Final Decision Engine, không gọi execution, không verify outcome và không sinh financial semantics.

## Database rollout gate

Apply [017_decision_core.sql](../src/database/migrations/017_decision_core.sql) trước khi bật `DECISION_PERSISTENCE=supabase`. Migration tạo decisions, immutable evidence snapshots, immutable audit events, outcome records, unique source/idempotency keys và RPC transaction boundaries.

## Safety boundaries

- Financial impact chỉ có `NOT_EVALUATED`.
- Không có expected/realized saving, avoidable cost hoặc financial calculator.
- Audit/evidence/outcome không được update/delete.
- Actor được ghi nhận và validate nhưng chưa có RBAC/session identity verification thực sự.
- Migration application và Supabase runtime verification là deployment responsibilities, chưa được giả định là hoàn tất chỉ vì file migration tồn tại.
