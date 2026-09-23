# OpsPilot Lean Reset V1 — audit and approval notes

**Baseline:** production commit `2c00a830dfaa0592166318f2184a918e60e649fd`

**Production changes:** none
**Database cleanup:** proposal only; no `DELETE` or `TRUNCATE` was run.

## One storage snapshot

Database total: **519.27 MB**. Relation sizes below are table plus indexes, sorted by total size. Table sizes are catalog measurements; row counts other than `order_snapshots` are stale `pg_stat` estimates and must not be treated as exact.

| Table | Table MB | Index MB | Total MB | `pg_stat` live / dead rows (estimate) |
|---|---:|---:|---:|---:|
| `order_snapshots` | 220.79 | 109.47 | 330.26 | ~4,110 / 0; exact count 514,787 |
| `inbound_order_observations` | 17.14 | 15.38 | 32.52 | ~120,060 / 9,704 |
| `incident_triage_evaluations` | 20.18 | 5.13 | 25.30 | ~0 / 0 |
| `followup_events` | 19.00 | 3.30 | 22.30 | ~0 / 0 |
| `incident_history` | 9.27 | 6.52 | 15.78 | ~258 / 0 |
| `notification_action_events` | 4.48 | 0.98 | 5.45 | ~0 / 0 |
| `followup_cases` | 4.39 | 0.46 | 4.85 | ~0 / 7 |
| `ai_analysis_jobs` | 1.00 | 1.27 | 2.27 | ~4,225 / 240 |
| `conversation_events` | 0.77 | 0.12 | 0.89 | ~0 / 0 |
| `planner_review_events` | 0.54 | 0.33 | 0.87 | ~3,550 / 0 |
| `telegram_followup_reminder_events` | 0.47 | 0.04 | 0.51 | ~0 / 0 |
| `sync_runs` | 0.11 | 0.06 | 0.17 | ~1 / 5 |

`pg_stat` live/dead counts above are stale catalog estimates, not exact counts; the `order_snapshots` `COUNT(*)` is exact. No extra row-count scan was used to inflate the snapshot.

## Table classification

| Table | Class | Minimum retention | Why required | Can purge old rows | Physical reset candidate |
|---|---|---|---|---|---|
| `order_snapshots` | SHORT_RETENTION | 48 hours, latest successful sync, and latest incomplete sync | Current incident detail, current recovery, and the latest complete projection | YES, under the staged keep-set | YES |
| `inbound_order_observations` | EVIDENCE_ONLY | Latest successful plus latest incomplete run (2 runs); retain their manifests | Exact inbound population invariant and idempotent failed-run resume | YES, older populations only | YES |
| `incident_history` | EVIDENCE_ONLY | Latest 2 per active incident; all decision-, verification-, and feedback-linked incidents | Current trend/detail and decision evidence | YES, outside the keep-set | YES, only after evidence gate |
| `incident_triage_evaluations` | EVIDENCE_ONLY | Latest current evaluation; retain rows referenced by `decision_telegram_shadows` | Current route and FK-protected Telegram decision evidence | YES, excluding latest/current and FK references | NO; a shadow FK uses `ON DELETE RESTRICT` |
| `followup_cases` | CURRENT_STATE | Current row for each case, including terminal state | Follow-up status, idempotency, next action, and manager workflow | NO while case state is current | NO |
| `followup_events` | SHORT_RETENTION | 3 days plus full history for active cases | Short recovery context; current state is in `followup_cases` | YES | YES, after evidence gate |
| `notification_action_events` | SHORT_RETENTION | 1 day, latest 50 per action, active actions, and decision-linked actions | Delivery recovery and current action state | YES | YES, after evidence gate |
| `planner_review_events` | EVIDENCE_ONLY | 3 days, latest 5 per run, and decision-linked planner runs | Bounded review history; manager decision audit remains in immutable `decision_audit_events` | YES, outside the keep-set | YES, after evidence gate |
| `conversation_events` | EVIDENCE_ONLY | Retain all current rows until an owner-approved, trigger-aware archive policy exists; 30 days is only a future floor | Current Telegram MB03 jobs read it; immutable trigger blocks row deletion | NO automatic purge proposed | NO; do not bypass its immutable trigger with `TRUNCATE` |
| `telegram_followup_reminder_events` | EVIDENCE_ONLY | Retain all current rows until an owner-approved, trigger-aware archive policy exists; 30 days is only a future floor | Telegram delivery audit; immutable trigger blocks row deletion | NO automatic purge proposed | NO; do not bypass its immutable trigger with `TRUNCATE` |
| `ai_analysis_jobs` | CURRENT_STATE | All `PENDING`/`PROCESSING`, last 7 days, and decision-linked jobs | AI queue capability and recent analysis evidence | YES, older terminal jobs only | YES, after evidence gate |
| `sync_runs` | SHORT_RETENTION | Latest success, latest incomplete, 48 hours, and every run referenced by retained evidence | Parent record for snapshots, histories, inbound rows, and resume | YES, only after dependent rows are reviewed | NO; tiny table and broad cascade risk |

## `order_snapshots` and inbound retention

```text
ORDER_SNAPSHOTS_CURRENT_SIZE: 330.26 MB including indexes
ORDER_SNAPSHOTS_CURRENT_ROWS: 514,787 exact
24H_ROWS: 4,110 exact
48H_ROWS: 18,527 exact
CRITICAL_CONSUMERS_REQUIRING_GT_24H: latest successful incident projection/order detail (the newest successful sync was about 27 hours old)
CRITICAL_CONSUMERS_REQUIRING_GT_48H: none found once latest success and latest incomplete run are explicit keep-set members
TRUNCATE_REBUILD_SAFE: YES, only as the locked, staged keep-set in the approval SQL; fetching fresh data alone is NO because the failed run is resumable evidence
RECOMMENDED_RETENTION: 48H plus latest successful and latest incomplete run
ESTIMATED_SIZE_AFTER_REBUILD: about 11.89 MB
ESTIMATED_IMMEDIATE_RECLAIM_IF_TRUNCATE: about 318.37 MB
```

The latest successful run is `93b93af7-11e9-45dd-ab4f-169e99d729d6`; the latest incomplete failed run is `1edc2ae6-04c5-47fd-b247-a8042ff518e9`. Keep both even if the 48-hour window moves. The prior successful run is not needed by the current inbound consumer, which uses the latest-success manifest without an older fallback.

```text
INBOUND_RUNS_REQUIRED: 2
OLDER_INBOUND_PURGE_SAFE: YES, after the owner approves and the two-run invariant is rechecked
```

The run counters report 9,557 observations for the latest success and 10,049 for the incomplete run. Against the stale ~120,060 row estimate, retaining 19,606 implies about 100,454 rows and 27.21 MB reclaimed. Treat both as estimates until the approval script's exact count preflight.

## Decision evidence and scheduled work

- All 24 current decisions had zero `decision_outcomes`; two `OUTCOME_PENDING -> INCONCLUSIVE` transitions are not observed outcome records. **`EVIDENCE_PACK_READY: NO`** because Outcome Case #2 is not present.
- Four strongest existing candidates have immutable `decision_evidence_snapshots` with `sourceIdentifiers` and `operationalFacts`: the near-term-capacity approval `7f056714-299b-4d8a-958d-0e6d4cdda913`, plus operational rollups `b891994d-b03d-47d2-be55-0a0918ea07e5`, `91c900c5-78dc-4e50-9d7a-04d1c8428a8c`, and `32e84bb8-1c54-4c58-98d6-6467cf2e6061`. These are candidates, not certified Golden/Outcome cases.
- Approval and rejection audit rows exist. There is no human `DRAFT -> DRAFT` edit record; the two such events are Telegram signals marked `transitionedDecision:false`. Preserve `decisions`, `decision_evidence_snapshots`, `decision_audit_events`, and `decision_outcomes` intact.
- Current schedules are the three daily jobs in `vercel.json`: AI queue processing, decision follow-ups, and MB03 outcome reminders. None is a repeated idle poll that should be disabled. Keep the schedule policy; `opspilot-followup-cycle-mb3` remains paused and V3 remains off.
- `conversation_events` is read and written by current MB03 Telegram flows and the reminder job; it is not debug-only despite not being on the dashboard path.

## Cleanup size and recovery notes

Only the first two rows have defensible current reclaim estimates from measured row counts. The other row counts are stale or depend on a retention predicate, so the approval SQL computes exact candidate/retained counts under lock. For staged table rebuilds, rollback the transaction before `COMMIT` restores the pre-cleanup state. After commit, removed raw histories are irreversible; immutable decision snapshots and audit tables are deliberately excluded.

| Table | Proposed action | Rows expected removed | Estimated reclaim | Recovery method | Irreversible loss |
|---|---|---:|---:|---|---|
| `order_snapshots` | Staged truncate/rebuild to 48h plus 2 run IDs | 496,260 exact from current counts | ~318.37 MB | Transaction rollback before commit; otherwise source re-sync cannot restore the failed run exactly | Older raw snapshots outside the keep-set |
| `inbound_order_observations` | Staged truncate/rebuild to 2 run IDs | ~100,454 from stale row estimate; preflight exact | ~27.21 MB estimate | Transaction rollback before commit; otherwise no older inbound population restore | Older normalized inbound rows |
| `incident_history` | Staged truncate/rebuild to latest 2 current plus decision/feedback-linked history | Exact count at owner preflight | Up to 15.78 MB; retained rows reduce reclaim | Transaction rollback before commit; do not re-sync as a substitute for historical evidence | Non-retained history |
| `followup_events` | Staged truncate/rebuild to 3 days plus all active-case events | Exact count at owner preflight | Up to 22.30 MB; retained rows reduce reclaim | Transaction rollback before commit; current state remains in `followup_cases` | Old transitions outside the keep-set |
| `notification_action_events` | Staged truncate/rebuild to 1 day, latest 50/action, active and decision-linked actions | Exact count at owner preflight | Up to 5.45 MB; retained rows reduce reclaim | Transaction rollback before commit; parent action state remains | Old provider-event detail outside the keep-set |
| `planner_review_events` | Staged truncate/rebuild to 3 days, latest 5/run, and decision-linked runs | Exact count at owner preflight | Up to 0.87 MB; retained rows reduce reclaim | Transaction rollback before commit; immutable decision audit remains | Old planner event detail outside the keep-set |
| `incident_triage_evaluations` | Delete only old unreferenced rows; not included in the truncate | Exact count at owner preflight | Immediate reclaim 0 MB; space is reusable after ordinary vacuum | No row-level restore after commit; rebuild from sync is not equivalent audit evidence | Old unreferenced triage evaluations |
| `ai_analysis_jobs` | Staged truncate/rebuild to active, 7-day, and decision-linked jobs | Exact count at owner preflight | Up to 2.27 MB; retained rows reduce reclaim | Transaction rollback before commit; terminal old analysis may not be reproducible | Old terminal job metadata |
| `conversation_events`, `telegram_followup_reminder_events`, `followup_cases`, `sync_runs` | No cleanup proposed | 0 | 0 MB | Not applicable | None |

`docs/lean-reset-v1-cleanup-approval.sql` contains an owner/evidence gate set to false, the locked exact-count preflight, staged cleanup statements, and explicit preservation predicates. It has not been run.

## Lean read path

- Dashboard now makes **6 bounded data-group calls**: current incidents with nested latest-2 histories/latest triage/current follow-up/latest planner status; bounded warehouse summary; bounded notification summary; latest 20 sync runs; current/recent AI jobs; and the current Copilot manager review queue. Planner history/recommendation enrichment is absent. It has no global histories/events, Telegram enrichment, health probes, or 30-second polling.
- Incident detail starts with one guarded bounded summary request (latest two histories, latest triage, current follow-up/decision context); deeper root-cause/planner/Copilot enrichment is manual. The first order page is capped at 25.
- GHN batch analysis is user-triggered. GHN/live tracking is only fetched after row expansion; the initial navigation and live status flow do not persist tracking cache.
- Follow-up keyset pagination, sync resume/idempotency, inbound natural-key and population-manifest checks, Telegram delivery paths, AI routes, and the schedule policy were not changed.
- `DEFAULT_READ_PATH_WRITES: 0`; `AUTO_GHN_INITIAL_LOAD: OFF`; `NONCRITICAL_JOBS_TO_DISABLE: none`.

## Release gate

Implementation is code-only, based on the stated production commit, and not deployed. The targeted dashboard/incident/order/follow-up/checkpoint/Telegram/inbound-resume suite passed (50 files, 250 tests); typecheck, lint, and the production build also passed before the single commit.
