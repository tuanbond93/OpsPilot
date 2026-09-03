# OpsPilot Project Status

Last Updated: 2026-09-03

## Season 2 — Level C Decision System

- Current state: **VALIDATED THROUGH LC-07**; Supabase migration schema verified, while end-to-end pilot runtime evidence is still pending.
- Current branch: `codex/season2-safe-checkpoint`
- Safe committed checkpoint: `1798ab1` — pilot debug baseline before the current MB03/Level C integration batch.
- Latest implementation checkpoint: LC-04 automatic Decision follow-up scheduling.
- Worktree status: integration batch in progress; MB03, Telegram decision, Rillnet review, GHN last-mile evidence and release-hardening changes await a new checkpoint.
- Migration evidence: on 2026-08-26, Supabase read-only checks returned HTTP 200 for `decisions`, `decision_followup_schedules`, `decision_outcome_observation_contracts`, and `decision_outcome_verifications`.
- Quality evidence (2026-09-03): secret scan PASS; TypeScript PASS; ESLint PASS; **92 test files / 475 tests PASS**; Next.js production build PASS.
- Integration freeze: GHN Data API, MCP Gateway and GTalk remain out of scope until company access is granted.
- Financial boundary: Decision Core remains `NOT_EVALUATED`; P15-B.1 remains the financial authority.

### Level C delivery status

| Work package | State | Evidence |
|---|---|---|
| LC-00 Repository Audit | COMPLETED | Actual repo mapping and full quality gates |
| LC-01 Final Decision Engine | VALIDATED | Deterministic candidate selection or `HUMAN_INVESTIGATION_REQUIRED` |
| LC-02 Decision Critic | VALIDATED | Independent fail-safe checks, reason codes and critic provenance |
| LC-03 Execution Boundary | VALIDATED | Manual external execution reference, idempotency, audit and critic guard |
| LC-04 Automatic Follow-up Scheduling | VALIDATED | One immutable decision-linked schedule after `EXECUTED`; risk cadence, retry idempotency and Inbox visibility |
| LC-05 Outcome Observation Contract | VALIDATED | Immutable baseline/evidence contract, measurement window and human-outcome guard |
| LC-06 Outcome Verifier | VALIDATED | Deterministic evidence-based verification with SUCCESS/FAILURE/INCONCLUSIVE abstain behavior |
| LC-07 Decision Memory | VALIDATED | Retrieval from verified comparable outcomes with explicit non-causal guard |
| Outcome Verifier | PLANNED | Starts only after LC-04 |
| Decision Memory / Learning | PLANNED | Requires verified outcomes |
| PnL / Verified Money | PLANNED | Must remain downstream of verification and P15-B.1 |

Current Level C flow:

```text
REAL/CURRENT DATA → AUTO DETECT → AI RCA → AI OPTIONS
→ FINAL DECISION → DECISION CRITIC → HUMAN APPROVE/REJECT
→ MANUAL EXTERNAL EXECUTION RECORD → AUTO FOLLOW-UP SCHEDULE → OBSERVATION CONTRACT → OUTCOME VERIFIER → DECISION MEMORY
```

First missing link: `verified operational outcome → safe financial handoff to P15-B.1`.

Pilot evidence rule (2026-08-31): the readiness scorecard counts a Decision outcome as Level C evidence only after an LC-06 `decision_outcome_verifications` record exists. An operator-observed outcome remains visible but is not treated as verified evidence.

> Post-V1 update (2026-08-23): the repository now includes the Sprint 13 production UI, Copilot human review, Decision Core, Pilot feedback/quality and learning-data workflows, plus Supabase authentication and role-based authorization. These additions remain subject to the validation evidence recorded by the current release run; the historical Sprint 12.4 declaration below is preserved.

Sprint: 12.4

Current Sprint State: COMPLETED

Latest Validated Sprint: 12.4

Latest Completed Sprint: 12.4

Current Branch: `codex/season2-safe-checkpoint`

Git Commit: `N/A` (LC-04 checkpoint not yet runtime-verified)

Repository Version: v1.0.0

Next Planned Sprint: POST-V1

Current Focus: V1 Release Candidate

## Sprint State Definitions

- **PLANNED** – no implementation has started.
- **IN PROGRESS** – implementation exists; one or more required validation/runtime steps remain incomplete.
- **VALIDATED** – implementation exists; TypeScript, ESLint, full test suite, and production build pass; runtime verification not yet completed or evidenced.
- **COMPLETED** – implementation is VALIDATED and actual runtime verification was executed with recorded outcome; required migrations applied and verified.
- **BLOCKED** – implementation or validation cannot continue because of a verified blocker.
- **FAILED** – implementation was attempted but acceptance criteria were not met.

## Evidence Rules

**Implementation Evidence** – source code files, factories, services, repositories, migrations.

**Validation Evidence** – successful `npm run lint`, `npx tsc --noEmit`, full Vitest test suite, production build.

**Runtime Verification Evidence** – real execution observed, such as:
- HTTP endpoint invocation (e.g., health or metrics API call)
- Cron/job execution in a running process
- Worker execution against actual queues
- Database migration applied and verified against the target DB
- Supabase query/result verification
- Process restart test confirming state rehydration
- Concurrent‑process lock acquisition test

Tests support validation but do **not** constitute runtime verification.

**Migration Application Evidence** – migration file exists **and** its execution has been confirmed against the database.

Do not invent branch, commit, or version values; use `N/A` when unavailable.

- Sprint history directory: [./sprint-history/](./sprint-history/)
- Unattributed implementation: [./sprint-history/UNATTRIBUTED_IMPLEMENTATION.md](./sprint-history/UNATTRIBUTED_IMPLEMENTATION.md)
- Verified sprint files count: **30**
- Fixed issue count: **8**
- Open issue count: **0**
- Accepted decision count: **3**
- Rejected decision count: **3**
