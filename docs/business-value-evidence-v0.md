# Business Value & Evidence Layer V0

This is a read-only reporting design. It does not change the follow-up engine,
cron scheduling, notification dispatch, incident state, or production data.

## Evidence map

| Metric / evidence | Authoritative source | Table / model / event | Fields | Confidence / gap |
| --- | --- | --- | --- | --- |
| Detected cohort | incident persistence | `incidents` | `id`, `incident_key`, `first_detected_at`, `last_detected_at`, warehouse and reason fields | High |
| Backlog evidence | snapshot history | `incident_history` | `recorded_at`, `affected_order_count`, order samples | High for observed backlog; no causal attribution |
| Scope / warehouse | incident + generated assignment directory | `incidents`, `warehouse-assignments.generated.json` | `warehouse_id`, `warehouse_name`, zone/province mapping | High where mapping exists; report unmapped separately |
| Suppression | follow-up state and Rillnet-review evidence | `followup_cases`, `followup_events` | `current_state`, Rillnet fields; `RILLNET_STATUS_CHANGED` | Partial: no single normalized exception/suppression field for all policies |
| Stage requests | follow-up event store | `followup_events` | `PUSH_REQUESTED`, `ESCALATION_REQUESTED`, old/new states, `event_time` | High |
| Stage confirmation | durable notification action + audit | `notification_actions`, `notification_action_events` | action type, outcome, status, provider message id; `DELIVERY_SUCCEEDED` | High only when delivered outcome/audit event exists; pending is not confirmation |
| Telegram message evidence | notification actions and pilot reminder records | `notification_actions`, `telegram_followup_reminders`, reminder events | `provider_message_id`, provider response, reminder event metadata | Partial: group dispatch can cover multiple cases |
| Resolution / closure | follow-up + incident state | `followup_cases`, `followup_events`, `incidents` | `resolved_at`, `closed_at`, `INCIDENT_RESOLVED`, `CASE_CLOSED` | High for observed resolution; not proof of causality |
| Duplicate prevention | action audit | `notification_action_events` | `ACTION_DEDUPLICATED`, deduplication key | High when audit events are retained |

## Canonical funnel and timestamps

`DETECTED` is one follow-up case with `incidents.first_detected_at` (falling
back to `followup_cases.first_detected_at`). `ACTIONABLE` is detected evidence
without a caller-supplied valid suppression. V0 intentionally does not invent
a suppression reason when the durable record is incomplete.

`FIRST_PUSH_CONFIRMED`, `SECOND_PUSH_CONFIRMED`, and `ESCALATED` require either
one case-linked durable action (`payload.incidentId` equals the case incident)
with delivered outcome and a provider message ID/audit confirmation. This is
**Level A** evidence. A grouped Telegram delivery remains Level A only when
each member retains its own linked durable action. A confirmed message with no
provable case membership is Level C and never confirms a case; generated or
pending action is Level D. `PENDING` and failed actions never count as
confirmation. A cancellation used to close a case-specific aggregate queue row
does not erase its delivered outcome, but still needs the case link and message
evidence.

Outcome groups are exclusive: the last confirmed governed action on or before
`resolved_at` determines `RESOLVED_AFTER_FIRST_PUSH`,
`RESOLVED_AFTER_SECOND_PUSH`, or `RESOLVED_AFTER_ESCALATION`. Unresolved,
suppressed, and missing-evidence cases are separate groups. Invalid ordering is
reported, never repaired.

The ordinary funnel stages (`DETECTED`, `ACTIONABLE`, `FIRST_PUSH_CONFIRMED`,
`SECOND_PUSH_REQUIRED`, `SECOND_PUSH_CONFIRMED`, and `ESCALATED`) may overlap:
one case can pass through each over time. Only the terminal dimension is
exclusive: `RESOLVED_AFTER_FIRST_PUSH`, `RESOLVED_AFTER_SECOND_PUSH`,
`RESOLVED_AFTER_ESCALATION`, `SUPPRESSED`, `STILL_UNRESOLVED`, and
`MISSING_EVIDENCE` partition supplied case rows. Each resolution rate uses its
confirmed-stage count as denominator and corresponding terminal outcome as
numerator. All metrics require the caller's explicit time window and scope;
records outside either are excluded and missing time remains `N/A`.

Durations are calculated only from valid ordered timestamps:
`detected_at`, `first_push_confirmed_at`, `second_push_confirmed_at`,
`escalated_at`, and `resolved_at`; unavailable data is `N/A`.

## Level-C evidence and attribution

`INPUT` = snapshot/history backlog evidence; `DECISION_BY_SYSTEM` = state/event
request under the governed policy; `ACTION_BY_SYSTEM` = confirmed dispatch;
`OUTCOME_OBSERVED` = subsequent durable resolution; `VALUE_ATTRIBUTABLE` is a
separate claim and is never inferred from timing alone.

| Level | Claim supported |
| --- | --- |
| 0 — temporal | Resolution happened after a detected case or action. |
| 1 — governed window | A confirmed governed action preceded resolution. V0's maximum automatic attribution. |
| 2 — response evidence | A linked operator/warehouse response supports the intervention path. |
| 3 — causal | Direct evidence establishes the action caused the outcome. |

For AI Revolution reporting, use Level 1 as the minimum defensible automated
reporting level; report Level 2/3 only with linked evidence.

## Suppression resolver contract

`resolveSuppressionEvidence(case)` is pure and read-only. It considers active
`order_exceptions` for supplied case order codes, the current
`RILLNET_CHANGE_PAUSED` state, and any explicitly supplied policy observation.
An expiry at or before the reference time is historical, not current.

The resolver returns `CURRENT`, `HISTORICAL`, `NONE`, `UNKNOWN`, or
`AMBIGUOUS`. A complete read is required before `NONE` is returned. Contradictory
current/none or current/unknown evidence is `AMBIGUOUS`; absence of an action
is never suppression evidence. Only `CURRENT` is excluded from actionable
metrics; unknown and ambiguous evidence remain visible as unknown rather than
being repaired into clean numbers.

Current sources are: `order_exceptions` (`reason_code`, `expires_at`; active
until expiry), `followup_cases.current_state = RILLNET_CHANGE_PAUSED` plus its
persisted review fields (active until manager review/resume), and explicit
read-adapter policy evidence. Approved-exception text in the incident builder
filters incoming orders but does not provide a durable case-level historical
suppression record, so it is not sufficient by itself for V0 analytics.

## Owner-input value schema

No value defaults are supplied. The typed owner-input contract includes:

| Input | Unit | Range | Mandatory | Evidence required |
| --- | --- | --- | --- | --- |
| `MANUAL_REVIEW_MINUTES_PER_CASE` | minutes/case | >0 | Yes | time study |
| `MANUAL_FOLLOWUP_MINUTES_PER_CASE` | minutes/case | >0 | Yes | time study |
| `LABOR_COST_PER_HOUR` | currency/hour | >0 | Yes | Finance-approved rate |
| `ESCALATION_HANDLING_MINUTES` | minutes/case | >0 | Yes | time study |
| `OPTIONAL_SLA_COST_PARAMETER` | currency/SLA unit | >0 | No | Finance-approved loss model |

Each value defaults to `null`; calculations are impossible until the owner
supplies evidence-backed values.

## Reporting semantics and scopes

The Telegram incident-status heartbeat is explicitly MB3-only: it loads all
follow-ups, filters their incident assignment to `zone === "Miền Bắc 3"`, and
reports that subset. The authenticated dashboard's selected filter can also be
Miền Bắc 3, while the follow-up engine evaluates the incoming incident set for
the checkpoint and is not inherently constrained by that dashboard filter.

`Có thay đổi` means the current affected-order count differs from the immediately
previous `incident_history` row, or the case is newly resolved. `Không thay đổi`
means the two latest historical counts are equal. Neither field means newly
actionable, a state transition, or a notification dispatch result. `Đang theo dõi`
is a UI outcome label for a non-resolved follow-up; `Sự cố đã hoàn thành` is the
resolved/closed status-update category. Therefore 103 vs 24 is a scope mismatch:
the status heartbeat's tracked MB3 candidate set is not a global engine total,
and it must not be compared directly to a dashboard-filtered active count.

The changed counter is **not decision-safe**: 10→8 and 10→12 both count as
changed, while 10→10 is unchanged; a missing prior row and a newly-created
case are also folded into changed, and reopening is not a separate label.
Replace it with `NEW_ACTIONABLE`, `BACKLOG_INCREASED`, `BACKLOG_DECREASED`,
`UNCHANGED`, `RESOLVED`, and `REOPENED`, each labelled as snapshot or
checkpoint delta and with an explicit scope.

## Proposed Control Center V2 queries

| Metric | Definition | Query shape | Kind / scope |
| --- | --- | --- | --- |
| Active backlog | open/monitoring incidents with latest history | incidents + latest history | Snapshot; global or explicit filter |
| New actionable | detected during window and no valid suppression | incidents + follow-up evidence | Delta; explicit checkpoint/scope |
| Push 1 / 2 sent | confirmed `FIRST_PUSH` / `SECOND_PUSH` actions | actions + delivery audit | Delta; global or explicit filter |
| Waiting / due | confirmed stage with an unexpired / due `next_action_at` | follow-up cases | Snapshot; explicit scope |
| Escalated | confirmed escalation action | actions + audit | Delta/snapshot; explicit scope |
| Resolved today | `resolved_at` in time window | follow-up cases/events | Delta; explicit scope |
| Suppressed / anomaly | normalized suppression or invalid ordering | read model input | Snapshot; do not show unknown as zero |

All UI metrics must label their time window and scope. Future savings formulas
remain parameterized: `manual_touches_avoided × verified_minutes_per_touch ×
verified_labor_cost_per_minute` or `backlog_resolved_earlier ×
verified_operational_cost_per_hour`; all parameters are owner inputs.
