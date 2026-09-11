# Adaptive Shadow Observation Layer V0

This build adds pure, versioned contracts only. It does not create a database migration, runtime hook, API route, cron entry, notification, queue item, or production write.

The follow-on implementation branch adds an unexecuted migration (`065_adaptive_shadow_observation_store.sql`) containing only four isolated append-only tables. IDs and `created_at` are server generated; insert idempotency uses unique keys; update/delete triggers reject history mutation. The writer has insert-only methods for snapshots, population membership, decisions, and outcomes. It has no operational methods.

The migration enables and forces RLS on all four tables, revokes all privileges from `PUBLIC`, `anon`, and `authenticated`, and grants only `SELECT`/`INSERT` to `service_role`. It deliberately creates no browser policies: warehouse users, managers, and admins have no direct table access. A future governed server API must enforce data scope before returning an approved read model. Service role remains privileged infrastructure, not physically immutable administration; it has no update/delete grant under this migration, while table owners and database administrators remain capable of changing database rules outside the application runtime.

Release telemetry is derived from snapshots: `SNAPSHOTS_CREATED`, `SNAPSHOT_WRITE_FAILURES`, and the fractions whose SLA, ETA, progress, driver, commitment, and exception evidence are known. These are data-quality measures only, not V2-effectiveness claims.

Feature matrix: both flags false = disabled; snapshot-write true/V2 false = snapshot-only; both true = full shadow; snapshot-write false/V2 true = disabled. A shadow decision is not persisted without a previously persisted snapshot. The fail-open composer returns V1 immediately and schedules bounded shadow work independently; it is not wired into V1 or cron in this change.

Release 1 adds a server-only assembler contract for the minimum current evidence set: dated backlog history, incident state/resolution, exceptions, confirmed interventions, structured Telegram response evidence, and independently nullable population membership. The Release 1 snapshot is defined as `POST_ACTION`: captured after V1's existing operational result is preserved, without changing that result. It records no V2 decision. SLA, ETA, route, driver, and commitment deliberately remain `UNKNOWN`/`null`.

`captureRelease1Observation` is a bounded server-side capture library with a 500 ms recommended budget and per-case failure counters. It is intentionally not wired into the current V1 checkpoint/cron route in this build; a separately reviewed server integration must call it after V1 completion. No notification, incident mutation, follow-up transition, or V2 import exists in this path.

`AdaptiveObservationSnapshot`, `CheckpointCaseSnapshot`, `AdaptiveShadowDecisionRecord`, and `ShadowOutcomeObservation` are append-only schemas. Unknown source values remain `null`/`UNKNOWN`; `appendObservation` rejects replacement of an existing snapshot ID in local fixtures. A future durable store must enforce the same unique-ID and insert-only constraints.

The source registry is in `registry.ts`. It distinguishes signals currently exposed by retained evidence from type-only aspirations: backlog, exception, confirmed intervention, and resolution are available; exact SLA, structured ETA, route, driver, commitment, and normalized operator response are not.

The normalizers use structured evidence only. They do not parse free text. Expired or weak ETA cannot be used as trusted progress. A commitment needs actor, recorded time, completion time, and source; conflicting commitments are ambiguous.

## Future failure isolation

The intended runtime is `V1 checkpoint → append observation → V2 shadow decision → append shadow decision`. V1 finishes first. Shadow exceptions are swallowed and recorded as shadow failure in a future isolated store; they cannot enqueue notifications, mutate cases, or change V1's result. The generic composition proof is local-only and is deliberately not wired into V1.

The only feature flags proposed are `ADAPTIVE_V2_SHADOW_ENABLED` and `SHADOW_SNAPSHOT_WRITE_ENABLED`, both default false. There is intentionally no V2 action-mode or dispatch flag.

## Retention estimate

The prior 900-row estimate omitted `checkpoint_case_snapshots`. Planning upper bound is three snapshots, three population-membership rows, three decisions, and one later outcome per decision: twelve rows/case/day. A snapshot-only release is lower (six rows/case/day); this is the full-shadow upper bound.

| Active cases/day | Rows/day | Rows/month (30d) |
| ---: | ---: | ---: |
| 100 | 1,200 | 36,000 |
| 500 | 6,000 | 180,000 |
| 1,000 | 12,000 | 360,000 |
| 5,000 | 60,000 | 1,800,000 |

At 90 days this is 108,000 / 540,000 / 1.08m / 5.4m rows; at 12 months it is approximately 438,000 / 2.19m / 4.38m / 21.9m rows. Keep 90 days hot for audit/replay; archive append-only records for 12 months, partitioned by observation month and warehouse/region where supported. No deletion or archival job is introduced; initially, archive can remain in the same database. This is a capacity estimate, not a production retention change.
