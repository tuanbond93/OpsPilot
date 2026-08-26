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

## LC-03 execution recording boundary

Decision `HUMAN_APPROVAL` ở trạng thái `APPROVED` có thể được chuyển sang `EXECUTED` qua:

```text
POST /api/decisions/:decisionId/execute
{
  "executionReference": "ticket-or-external-record",
  "performedAt": "optional ISO timestamp",
  "note": "optional reconciliation note",
  "idempotencyKey": "stable retry key"
}
```

Endpoint chỉ ghi nhận công việc đã diễn ra bên ngoài bằng `MANUAL_EXTERNAL`; nó không gửi lệnh vận hành. Reference là bắt buộc, transition và audit có idempotency, SHADOW vẫn read-only, và decision bị Critic chuyển sang `HUMAN_INVESTIGATION_REQUIRED` không thể được ghi executed.

## Database rollout gate

Apply [017_decision_core.sql](../src/database/migrations/017_decision_core.sql) trước khi bật `DECISION_PERSISTENCE=supabase`. Migration tạo decisions, immutable evidence snapshots, immutable audit events, outcome records, unique source/idempotency keys và RPC transaction boundaries.

## Safety boundaries

- Financial impact chỉ có `NOT_EVALUATED`.
- Không có expected/realized saving, avoidable cost hoặc financial calculator.
- Audit/evidence/outcome không được update/delete.
- Actor được ghi nhận và validate nhưng chưa có RBAC/session identity verification thực sự.
- Migration application và Supabase runtime verification là deployment responsibilities, chưa được giả định là hoàn tất chỉ vì file migration tồn tại.

## LC-04 — Automatic follow-up scheduling

Khi audit event `EXECUTED` được ghi thành công, Decision Core tự tạo đúng một
`decision_followup_schedules` record trong cùng transaction database. Lịch kiểm tra
được tính cố định theo risk snapshot: CRITICAL 60 phút, HIGH 120 phút, MEDIUM 240 phút,
LOW 480 phút. Retry execution không tạo lịch trùng.

Schedule chỉ trả lời “khi nào cần lấy bằng chứng mới”. Nó không tự thực thi action,
không tự kết luận outcome và không tính expected/realized saving. Outcome observation
contract thuộc LC-05; financial authority vẫn là P15-B.1.

## LC-05 — Outcome observation contract

Mỗi schedule LC-04 tạo đúng một `decision_outcome_observation_contracts` record trong
cùng transaction. Contract là immutable và ghi lại baseline evidence snapshot, thời điểm
execution, điểm kết thúc cửa sổ đo (`checkAt`) và evidence bắt buộc: execution reference
và post-execution operational snapshot.

Với `HUMAN_APPROVAL`, outcome chỉ được ghi tại hoặc sau khi cửa sổ đo kết thúc và phải có
evidence reference. LC-05 chưa tự phân loại outcome; đó là trách nhiệm LC-06. Baseline có
nguồn là snapshot lúc Decision được tạo, nên Outcome Verifier phải đánh giá freshness và
đủ dữ liệu trước khi dùng nó để kết luận.

## LC-06 — Outcome verifier

`POST /api/decisions/:decisionId/verify` nhận operational snapshot sau cửa sổ đo và
evidence refs, rồi ghi verification provenance cùng outcome trong một database transaction.
Với metric `affectedOrders`, rule deterministic là: `0` → `SUCCESS`; không giảm hoặc tăng
so với baseline → `FAILURE`; giảm nhưng chưa về `0`, hoặc metric không đủ → `INCONCLUSIVE`.

Verifier không gọi AI để đoán, không tự thực thi action, không chấm outcome trước cửa sổ đo
và không tạo saving/cost. Những metric hay SLA khác chưa có policy phải đi vào
`INCONCLUSIVE`, không được tự thêm ngưỡng.

## LC-07 — Decision memory

`GET /api/decisions/:decisionId/memory` chỉ truy xuất các Decision có outcome đã được
LC-06 verifier ghi nhận. Similarity dựa trên source type, risk level, reason code và
candidate type; mỗi match luôn mang `nonCausalNotice`. Memory không tự thay recommendation,
không aggregate money và không dùng các outcome do người dùng ghi tay không qua verifier.
